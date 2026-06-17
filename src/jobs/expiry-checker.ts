import Bull from 'bull';
import { config } from '../config';
import { getDb } from '../database/connection';
import { cacheExpiringItems } from '../services/redis';
import { updateHASensor, sendHANotification } from '../services/home-assistant';
import { FOOD_CATEGORY_MAP, FoodCategory } from '../services/food-defaults';

// 创建 Bull 队列
const expiryQueue = new Bull('expiry-check', config.redis.url);

/**
 * 启动过期巡检定时任务
 * 每天早上 8:00 执行
 */
export function startExpiryChecker(): void {
  // 每天早上 8 点执行一次
  expiryQueue.add(
    'daily-check',
    {},
    {
      repeat: { cron: '0 8 * * *' }, // 每天 08:00
      removeOnComplete: 10,
      removeOnFail: 5,
    }
  );

  // 启动后立即检查一次
  expiryQueue.add('startup-check', {}, { delay: 5000 });

  // 处理任务
  expiryQueue.process('daily-check', processExpiryCheck);
  expiryQueue.process('startup-check', processExpiryCheck);

  console.log('⏰ 过期巡检任务已注册 (每天 08:00)');
}

/**
 * 过期巡检逻辑
 * 根据食物品类的不同，使用不同的提前提醒天数：
 * - 肉类：提前 1 天
 * - 蔬菜/水果：提前 2 天
 * - 乳制品/其他：提前 3 天
 * - 饮料：提前 7 天
 * - 调味品：提前 14 天
 */
async function processExpiryCheck(): Promise<void> {
  console.log('🔍 开始过期巡检...');

  const db = getDb();
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // 获取所有家庭
  const families = await db('families').select('*');

  for (const family of families) {
    // 查询所有未过期、未删除的食物
    const allItems = await db('food_items')
      .where({ family_id: family.id })
      .whereNull('deleted_at')
      .where('expiry_date', '>=', todayStr)
      .select('name', 'expiry_date', 'quantity', 'unit', 'category');

    // 根据每个食物的品类，判断是否进入提醒窗口
    const expiringItems = allItems.filter((item) => {
      const category = (item.category as FoodCategory) || 'OTHER';
      const reminderDays = FOOD_CATEGORY_MAP[category]?.reminderDaysBefore ?? 3;
      const expiry = new Date(item.expiry_date);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      return daysLeft <= reminderDays;
    });

    // 查询已过期的食物
    const expiredItems = await db('food_items')
      .where({ family_id: family.id })
      .whereNull('deleted_at')
      .where('expiry_date', '<', todayStr)
      .select('name', 'expiry_date', 'quantity', 'unit', 'category');

    // 计算剩余天数并按紧急程度排序
    const itemsWithDaysLeft = expiringItems
      .map((item) => {
        const expiry = new Date(item.expiry_date);
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        return { ...item, days_left: Math.max(0, daysLeft) };
      })
      .sort((a, b) => a.days_left - b.days_left);

    // 更新 Redis 缓存
    await cacheExpiringItems(family.id, itemsWithDaysLeft);

    // 更新 HA 传感器
    if (family.ha_entity_prefix) {
      await updateHASensor(family.ha_entity_prefix, itemsWithDaysLeft);
    }

    // 有即将过期或已过期食物时发送通知（按品类分组）
    if (expiringItems.length > 0 || expiredItems.length > 0) {
      const messages: string[] = [];

      if (expiringItems.length > 0) {
        // 按紧急程度分组提醒
        const urgent = itemsWithDaysLeft.filter((i) => i.days_left <= 1);
        const soon = itemsWithDaysLeft.filter((i) => i.days_left > 1);

        if (urgent.length > 0) {
          const names = urgent.map((i) => `${i.name}(今天)`).join('、');
          messages.push(`🚨 紧急: ${names}`);
        }
        if (soon.length > 0) {
          const names = soon.map((i) => `${i.name}(${i.days_left}天)`).join('、');
          messages.push(`⚠️ 即将过期: ${names}`);
        }
      }

      if (expiredItems.length > 0) {
        const names = expiredItems.map((i) => i.name).join('、');
        messages.push(`❌ 已过期: ${names}`);
      }

      await sendHANotification('食物管家提醒', messages.join('\n'));
    }

    console.log(
      `  📦 ${family.name}: ${expiringItems.length} 项即将过期, ${expiredItems.length} 项已过期`
    );
  }

  // 更新 days_to_expiry 字段
  await db.raw(`
    UPDATE food_items 
    SET days_to_expiry = (expiry_date - CURRENT_DATE)::int,
        updated_at = NOW()
    WHERE deleted_at IS NULL
  `);

  console.log('✅ 过期巡检完成');
}
