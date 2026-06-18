import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../database/connection';
import { recognizeFood } from '../services/lmstudio';
import { invalidateInventoryCache } from '../services/redis';
import { inferCategory, getDefaultExpiryDays, getDefaultStorageLocation, FOOD_CATEGORY_MAP, FoodCategory } from '../services/food-defaults';
import { sendHANotification, updateHAInventorySensor, updateHASensor } from '../services/home-assistant';

export const ingestRouter = Router();

/**
 * 校验日期字符串是否有效 (YYYY-MM-DD)
 */
function isValidDate(dateStr: string): boolean {
  const d = new Date(dateStr);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * 录入后刷新 HA 仪表盘传感器
 */
async function refreshHADashboard(familyId: string): Promise<void> {
  try {
    const db = getDb();
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // 获取家庭信息
    const family = await db('families').where({ id: familyId }).first();
    if (!family?.ha_entity_prefix) return;

    // 查询所有未删除的食物
    const allItems = await db('food_items')
      .where({ family_id: familyId })
      .whereNull('deleted_at')
      .select('name', 'expiry_date', 'quantity', 'unit', 'category', 'storage_location');

    const inventoryItems = allItems.map((item) => {
      const expiry = new Date(item.expiry_date);
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const category = (item.category as FoodCategory) || 'OTHER';
      const reminderDays = FOOD_CATEGORY_MAP[category]?.reminderDaysBefore ?? 3;

      let status: 'expired' | 'expiring' | 'fresh' = 'fresh';
      if (daysLeft < 0) status = 'expired';
      else if (daysLeft <= reminderDays) status = 'expiring';

      return {
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        category: item.category || 'OTHER',
        expiry_date: item.expiry_date,
        days_left: daysLeft,
        storage_location: item.storage_location || 'PANTRY',
        status,
      };
    }).sort((a, b) => a.days_left - b.days_left);

    await updateHAInventorySensor(family.ha_entity_prefix, inventoryItems);

    // 也更新即将过期传感器
    const expiringItems = inventoryItems
      .filter(i => i.status === 'expiring')
      .map(i => ({ name: i.name, expiry_date: i.expiry_date, days_left: i.days_left }));
    await updateHASensor(family.ha_entity_prefix, expiringItems);
  } catch (error: any) {
    console.error('❌ 刷新 HA 仪表盘失败:', error.message);
  }
}

// 请求校验 Schema
const IngestPhotoSchema = z.object({
  family_id: z.string().uuid(),
  image_base64: z.string().min(100), // Base64 至少有一定长度
  shoot_time: z.string().datetime().optional(),
});

/**
 * POST /api/v1/ingest/photo
 * 核心接口：接收图片，调用 AI 识别，入库
 * 支持 ?async=true 异步模式（iPhone快捷指令推荐使用，避免超时）
 */
ingestRouter.post('/photo', async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. 参数校验
    const parsed = IngestPhotoSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: -1,
        message: '参数校验失败',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { family_id, image_base64, shoot_time } = parsed.data;

    // 异步模式：立即返回，后台处理
    const isAsync = req.query.async === 'true';

    if (isAsync) {
      // 先返回响应，再后台处理
      res.status(202).json({
        code: 0,
        message: '已收到图片，正在后台识别中，稍后会通过 HA 通知结果',
      });

      // 后台异步处理
      processPhoto(family_id, image_base64, shoot_time).catch((err) => {
        console.error('❌ Async ingest error:', err.message);
      });
      return;
    }

    // 2. 图片大小检查 (Base64 每4字符约3字节)
    const estimatedSize = (image_base64.length * 3) / 4;
    if (estimatedSize > 10 * 1024 * 1024) {
      res.status(413).json({ code: -1, message: '图片大小超过 10MB 限制' });
      return;
    }

    // 3. 调用 LMStudio 视觉模型
    let aiItems;
    let aiRawResponse = '';
    try {
      aiItems = await recognizeFood(image_base64);
      aiRawResponse = JSON.stringify(aiItems);
    } catch (aiError: any) {
      res.status(502).json({
        code: -2,
        message: `AI 识别失败: ${aiError.message}`,
        suggestion: '请确认 LMStudio 服务正在运行',
      });
      return;
    }

    if (aiItems.length === 0) {
      res.status(200).json({
        code: 0,
        data: { parsed_items: [], total_saved: 0, ai_raw_response: aiRawResponse },
        message: '未识别到食物',
      });
      return;
    }

    // 4. 数据处理与入库
    const db = getDb();
    const purchaseDate = shoot_time ? new Date(shoot_time) : new Date();
    const savedItems = [];

    for (const item of aiItems) {
      const category = inferCategory(item.name);

      // 过期日期计算优先级：
      // 1. AI 直接识别到的 expiry_date（包装标注"有效期至"）
      // 2. production_date + shelf_life_days（生产日期 + 保质期天数）
      // 3. purchase_date + estimated_expiry_days（拍照日期 + AI 估算天数）
      // 4. purchase_date + 品类默认保质期（兜底）
      let expiryDate: Date;
      let computedSource = 'DEFAULT'; // 记录过期日期的来源

      if (item.expiry_date && isValidDate(item.expiry_date)) {
        // 情况 1：直接识别到过期日期
        expiryDate = new Date(item.expiry_date);
        computedSource = 'PACKAGE_EXPIRY';
      } else if (item.production_date && isValidDate(item.production_date) && item.shelf_life_days) {
        // 情况 2：生产日期 + 保质期天数
        expiryDate = new Date(item.production_date);
        expiryDate.setDate(expiryDate.getDate() + item.shelf_life_days);
        computedSource = 'PRODUCTION_PLUS_SHELF';
      } else if (item.estimated_expiry_days) {
        // 情况 3：AI 估算的剩余天数
        expiryDate = new Date(purchaseDate);
        expiryDate.setDate(expiryDate.getDate() + item.estimated_expiry_days);
        computedSource = 'AI_ESTIMATED';
      } else {
        // 情况 4：品类默认值兜底
        const defaultDays = getDefaultExpiryDays(item.name);
        expiryDate = new Date(purchaseDate);
        expiryDate.setDate(expiryDate.getDate() + defaultDays);
        computedSource = 'CATEGORY_DEFAULT';
      }

      // 计算从今天到过期的天数
      const now = new Date();
      const daysToExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      // 确定购买/生产日期
      const actualPurchaseDate = item.production_date && isValidDate(item.production_date)
        ? item.production_date
        : purchaseDate.toISOString().split('T')[0];

      const record = {
        family_id,
        name: item.name,
        original_name: item.name,
        category,
        quantity: item.quantity,
        unit: item.unit,
        purchase_date: actualPurchaseDate,
        expiry_date: expiryDate.toISOString().split('T')[0],
        days_to_expiry: daysToExpiry,
        storage_location: getDefaultStorageLocation(item.name),
        source: 'PHOTO' as const,
      };

      const [inserted] = await db('food_items').insert(record).returning('*');
      savedItems.push({
        name: inserted.name,
        quantity: inserted.quantity,
        unit: inserted.unit,
        expiry_date: inserted.expiry_date,
        expiry_source: computedSource,
      });
    }

    // 5. 清除缓存，触发 HA 同步
    await invalidateInventoryCache(family_id);
    await refreshHADashboard(family_id);

    // 6. 返回成功
    res.status(200).json({
      code: 0,
      data: {
        parsed_items: savedItems,
        total_saved: savedItems.length,
        ai_raw_response: aiRawResponse,
      },
    });
  } catch (error: any) {
    console.error('❌ Ingest error:', error);
    res.status(500).json({ code: -99, message: `服务器内部错误: ${error.message}` });
  }
});


// ========== 方式 2：手动文本录入 ==========

const IngestManualSchema = z.object({
  family_id: z.string().uuid(),
  items: z.array(z.object({
    name: z.string().min(1),
    quantity: z.number().positive().default(1),
    unit: z.string().default('个'),
    production_date: z.string().optional(),   // YYYY-MM-DD
    expiry_date: z.string().optional(),       // YYYY-MM-DD
    shelf_life_days: z.number().positive().optional(),
    storage_location: z.enum(['FRIDGE', 'FREEZER', 'PANTRY']).optional(),
  })),
});

/**
 * POST /api/v1/ingest/manual
 * 手动录入食物（无需拍照，直接输入名称和信息）
 * 适用于：语音输入、文字输入、批量导入
 */
ingestRouter.post('/manual', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = IngestManualSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: -1,
        message: '参数校验失败',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { family_id, items } = parsed.data;
    const db = getDb();
    const savedItems = [];

    for (const item of items) {
      const category = inferCategory(item.name);
      const now = new Date();

      // 过期日期计算
      let expiryDate: Date;
      let computedSource = 'CATEGORY_DEFAULT';

      if (item.expiry_date && isValidDate(item.expiry_date)) {
        expiryDate = new Date(item.expiry_date);
        computedSource = 'MANUAL_EXPIRY';
      } else if (item.production_date && isValidDate(item.production_date) && item.shelf_life_days) {
        expiryDate = new Date(item.production_date);
        expiryDate.setDate(expiryDate.getDate() + item.shelf_life_days);
        computedSource = 'PRODUCTION_PLUS_SHELF';
      } else if (item.shelf_life_days) {
        expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + item.shelf_life_days);
        computedSource = 'SHELF_LIFE';
      } else {
        const defaultDays = getDefaultExpiryDays(item.name);
        expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + defaultDays);
      }

      const daysToExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const record = {
        family_id,
        name: item.name,
        original_name: item.name,
        category,
        quantity: item.quantity,
        unit: item.unit,
        purchase_date: item.production_date || now.toISOString().split('T')[0],
        expiry_date: expiryDate.toISOString().split('T')[0],
        days_to_expiry: daysToExpiry,
        storage_location: item.storage_location || getDefaultStorageLocation(item.name),
        source: 'MANUAL' as const,
      };

      const [inserted] = await db('food_items').insert(record).returning('*');
      savedItems.push({
        name: inserted.name,
        quantity: inserted.quantity,
        unit: inserted.unit,
        expiry_date: inserted.expiry_date,
        expiry_source: computedSource,
      });
    }

    await invalidateInventoryCache(family_id);
    await refreshHADashboard(family_id);

    res.status(200).json({
      code: 0,
      data: { saved_items: savedItems, total_saved: savedItems.length },
    });
  } catch (error: any) {
    console.error('❌ Manual ingest error:', error);
    res.status(500).json({ code: -99, message: `服务器内部错误: ${error.message}` });
  }
});

// ========== 方式 3：文本描述录入（AI 解析自然语言）==========

const IngestTextSchema = z.object({
  family_id: z.string().uuid(),
  text: z.string().min(2), // 如 "买了3个苹果、1盒牛奶、500g猪肉"
});

/**
 * POST /api/v1/ingest/text
 * 自然语言文本录入（AI 解析文字描述）
 * 适用于：语音转文字、Siri快捷指令语音输入、微信消息转发
 */
ingestRouter.post('/text', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = IngestTextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: -1,
        message: '参数校验失败',
        errors: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { family_id, text } = parsed.data;

    // 调用 LMStudio 用文本模式解析
    const { config } = await import('../config');
    const axios = (await import('axios')).default;

    const payload = {
      model: config.lmstudio.model,
      messages: [
        {
          role: 'user',
          content: `你是一个食物信息提取专家。请从以下文字中提取所有食物信息，返回JSON数组。

文字内容："${text}"

严格按照以下格式返回，不要包含其他文字：
[{"name": "中文名称", "quantity": 数字, "unit": "个/克/毫升/盒/袋", "estimated_expiry_days": 数字(从今天算起的保质天数)}]

如果提到了生产日期或保质期，也请包含：
"production_date": "YYYY-MM-DD", "shelf_life_days": 数字, "expiry_date": "YYYY-MM-DD"`,
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
      stream: false,
    };

    let aiItems;
    try {
      const response = await axios.post(
        `${config.lmstudio.host}/v1/chat/completions`,
        payload,
        { timeout: config.lmstudio.timeout }
      );
      const content = response.data?.choices?.[0]?.message?.content || '';

      // 解析 JSON
      let cleaned = content.trim().replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) cleaned = arrayMatch[0];
      aiItems = JSON.parse(cleaned);
    } catch (aiError: any) {
      res.status(502).json({
        code: -2,
        message: `AI 解析失败: ${aiError.message}`,
      });
      return;
    }

    // 入库逻辑（复用手动录入的计算方式）
    const db = getDb();
    const savedItems = [];
    const now = new Date();

    for (const item of aiItems) {
      if (!item.name) continue;
      const category = inferCategory(item.name);

      let expiryDate: Date;
      let computedSource = 'CATEGORY_DEFAULT';

      if (item.expiry_date && isValidDate(item.expiry_date)) {
        expiryDate = new Date(item.expiry_date);
        computedSource = 'TEXT_EXPIRY';
      } else if (item.production_date && isValidDate(item.production_date) && item.shelf_life_days) {
        expiryDate = new Date(item.production_date);
        expiryDate.setDate(expiryDate.getDate() + item.shelf_life_days);
        computedSource = 'PRODUCTION_PLUS_SHELF';
      } else if (item.estimated_expiry_days) {
        expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + Number(item.estimated_expiry_days));
        computedSource = 'AI_ESTIMATED';
      } else {
        const defaultDays = getDefaultExpiryDays(item.name);
        expiryDate = new Date(now);
        expiryDate.setDate(expiryDate.getDate() + defaultDays);
      }

      const daysToExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const record = {
        family_id,
        name: item.name.trim(),
        original_name: item.name.trim(),
        category,
        quantity: Number(item.quantity) || 1,
        unit: item.unit || '个',
        purchase_date: now.toISOString().split('T')[0],
        expiry_date: expiryDate.toISOString().split('T')[0],
        days_to_expiry: daysToExpiry,
        storage_location: getDefaultStorageLocation(item.name),
        source: 'TEXT' as const,
      };

      const [inserted] = await db('food_items').insert(record).returning('*');
      savedItems.push({
        name: inserted.name,
        quantity: inserted.quantity,
        unit: inserted.unit,
        expiry_date: inserted.expiry_date,
        expiry_source: computedSource,
      });
    }

    await invalidateInventoryCache(family_id);
    await refreshHADashboard(family_id);

    res.status(200).json({
      code: 0,
      data: { saved_items: savedItems, total_saved: savedItems.length, original_text: text },
    });
  } catch (error: any) {
    console.error('❌ Text ingest error:', error);
    res.status(500).json({ code: -99, message: `服务器内部错误: ${error.message}` });
  }
});


// ========== 异步后台处理函数 ==========

/**
 * 后台处理图片识别与入库，完成后通过 HA 发送通知
 */
async function processPhoto(familyId: string, imageBase64: string, shootTime?: string): Promise<void> {
  const purchaseDate = shootTime ? new Date(shootTime) : new Date();

  // 调用 AI
  const aiItems = await recognizeFood(imageBase64);

  if (aiItems.length === 0) {
    await sendHANotification('食物录入', '📷 未识别到食物，请重新拍照');
    return;
  }

  // 入库
  const db = getDb();
  const names: string[] = [];

  for (const item of aiItems) {
    const category = inferCategory(item.name);

    let expiryDate: Date;
    if (item.expiry_date && isValidDate(item.expiry_date)) {
      expiryDate = new Date(item.expiry_date);
    } else if (item.production_date && isValidDate(item.production_date) && item.shelf_life_days) {
      expiryDate = new Date(item.production_date);
      expiryDate.setDate(expiryDate.getDate() + item.shelf_life_days);
    } else if (item.estimated_expiry_days) {
      expiryDate = new Date(purchaseDate);
      expiryDate.setDate(expiryDate.getDate() + item.estimated_expiry_days);
    } else {
      const defaultDays = getDefaultExpiryDays(item.name);
      expiryDate = new Date(purchaseDate);
      expiryDate.setDate(expiryDate.getDate() + defaultDays);
    }

    const now = new Date();
    const daysToExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const actualPurchaseDate = item.production_date && isValidDate(item.production_date)
      ? item.production_date
      : purchaseDate.toISOString().split('T')[0];

    await db('food_items').insert({
      family_id: familyId,
      name: item.name,
      original_name: item.name,
      category,
      quantity: item.quantity,
      unit: item.unit,
      purchase_date: actualPurchaseDate,
      expiry_date: expiryDate.toISOString().split('T')[0],
      days_to_expiry: daysToExpiry,
      storage_location: getDefaultStorageLocation(item.name),
      source: 'PHOTO',
    });

    names.push(`${item.name}×${item.quantity}${item.unit}`);
  }

  await invalidateInventoryCache(familyId);
  await refreshHADashboard(familyId);

  // 通过 HA 发送通知到 iPhone
  await sendHANotification(
    '✅ 食物已录入',
    `识别到 ${names.length} 项: ${names.join('、')}`
  );

  console.log(`✅ 异步录入完成: ${names.join('、')}`);
}
