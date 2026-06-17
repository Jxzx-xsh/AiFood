import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../database/connection';
import { recognizeFood } from '../services/lmstudio';
import { invalidateInventoryCache } from '../services/redis';
import { inferCategory, getDefaultExpiryDays, getDefaultStorageLocation } from '../services/food-defaults';

export const ingestRouter = Router();

// 请求校验 Schema
const IngestPhotoSchema = z.object({
  family_id: z.string().uuid(),
  image_base64: z.string().min(100), // Base64 至少有一定长度
  shoot_time: z.string().datetime().optional(),
});

/**
 * POST /api/v1/ingest/photo
 * 核心接口：接收图片，调用 AI 识别，入库
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
      const expiryDays = item.estimated_expiry_days || getDefaultExpiryDays(item.name);
      const expiryDate = new Date(purchaseDate);
      expiryDate.setDate(expiryDate.getDate() + expiryDays);

      const record = {
        family_id,
        name: item.name,
        original_name: item.name,
        category,
        quantity: item.quantity,
        unit: item.unit,
        purchase_date: purchaseDate.toISOString().split('T')[0],
        expiry_date: expiryDate.toISOString().split('T')[0],
        days_to_expiry: expiryDays,
        storage_location: getDefaultStorageLocation(item.name),
        source: 'PHOTO',
      };

      const [inserted] = await db('food_items').insert(record).returning('*');
      savedItems.push({
        name: inserted.name,
        quantity: inserted.quantity,
        unit: inserted.unit,
        expiry_date: inserted.expiry_date,
      });
    }

    // 5. 清除缓存，触发 HA 同步
    await invalidateInventoryCache(family_id);

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
