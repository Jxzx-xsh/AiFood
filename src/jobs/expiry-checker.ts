import Bull from 'bull';
import { config } from '../config';
import { getDb } from '../database/connection';
import { cacheExpiringItems } from '../services/redis';
import { updateHASensor, sendHANotification } from '../services/home-assistant';

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
 */
async function processExpiryCheck(): Promise<void> {
  console.log('🔍 开始过期巡检...');

  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const threeDaysLater = new Date();
  threeDaysLater.setDate(threeDaysLater.getDate() + 3);
  const threeDaysStr = threeDaysLater.toISOString().split('T')[0];

  // 获取所有家庭
  const families = await db('families').select('*');

  for (const family of families) {
    // 查询即将过期的食物 (3天内)
    const expiringItems = await db('food_items')
      .where({ family_id: family.id })
      .whereNull('deleted_at')
      .where('expiry_date', '>=', today)
      .where('expiry_date', '<=', threeDaysStr)
      .select('name', 'expiry_date', 'quantity', 'unit');

    // 查询已过期的食物
    const expiredItems = await db('food_items')
      .where({ family_id: family.id })
      .whereNull('deleted_at')
      .where('expiry_date', '<', today)
      .select('name', 'expiry_date', 'quantity', 'unit');

    // 计算剩余天数
    const itemsWithDaysLeft = expiringItems.map((item) => {
      const expiry = new Date(item.expiry_date);
      const now = new Date();
      const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return { ...item, days_left: Math.max(0, daysLeft) };
    });

    // 更新 Redis 缓存
    await cacheExpiringItems(family.id, itemsWithDaysLeft);

    // 更新 HA 传感器
    if (family.ha_entity_prefix) {
      await updateHASensor(family.ha_entity_prefix, itemsWithDaysLeft);
    }

    // 有即将过期或已过期食物时发送通知
    if (expiringItems.length > 0 || expiredItems.length > 0) {
      const messages: string[] = [];
      if (expiringItems.length > 0) {
        const names = expiringItems.map((i) => i.name).join('、');
        messages.push(`⚠️ ${expiringItems.length} 项食物即将过期: ${names}`);
      }
      if (expiredItems.length > 0) {
        const names = expiredItems.map((i) => i.name).join('、');
        messages.push(`🚨 ${expiredItems.length} 项食物已过期: ${names}`);
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
