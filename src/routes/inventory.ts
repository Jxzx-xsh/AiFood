import { Router, Request, Response } from 'express';
import { getDb } from '../database/connection';
import { getRedis } from '../services/redis';

export const inventoryRouter = Router();

/**
 * GET /api/v1/inventory?family_id={id}
 * 获取某个家庭的全部库存
 */
inventoryRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { family_id } = req.query;
    if (!family_id) {
      res.status(400).json({ code: -1, message: '缺少 family_id 参数' });
      return;
    }

    const db = getDb();
    const items = await db('food_items')
      .where({ family_id, deleted_at: null })
      .orderBy('expiry_date', 'asc');

    res.json({ code: 0, data: { items, total: items.length } });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * GET /api/v1/inventory/expiring?family_id={id}&days=3
 * 获取未来 N 天内即将过期的食物
 */
inventoryRouter.get('/expiring', async (req: Request, res: Response): Promise<void> => {
  try {
    const { family_id, days = '3' } = req.query;
    if (!family_id) {
      res.status(400).json({ code: -1, message: '缺少 family_id 参数' });
      return;
    }

    const daysNum = parseInt(days as string, 10);
    const redis = getRedis();
    const cacheKey = `expiring:${family_id}:${daysNum}`;

    // 先查缓存
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.json({ code: 0, data: JSON.parse(cached), source: 'cache' });
      return;
    }

    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysNum);
    const futureDateStr = futureDate.toISOString().split('T')[0];

    const items = await db('food_items')
      .where({ family_id })
      .whereNull('deleted_at')
      .where('expiry_date', '>=', today)
      .where('expiry_date', '<=', futureDateStr)
      .orderBy('expiry_date', 'asc');

    const result = { items, total: items.length, days: daysNum };

    // 缓存 30 分钟
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 1800);

    res.json({ code: 0, data: result });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * GET /api/v1/inventory/expired?family_id={id}
 * 获取已过期的食物
 */
inventoryRouter.get('/expired', async (req: Request, res: Response): Promise<void> => {
  try {
    const { family_id } = req.query;
    if (!family_id) {
      res.status(400).json({ code: -1, message: '缺少 family_id 参数' });
      return;
    }

    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const items = await db('food_items')
      .where({ family_id })
      .whereNull('deleted_at')
      .where('expiry_date', '<', today)
      .orderBy('expiry_date', 'asc');

    res.json({ code: 0, data: { items, total: items.length } });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * DELETE /api/v1/inventory/:id
 * 软删除食物（标记为已消耗/丢弃）
 */
inventoryRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const db = getDb();

    const updated = await db('food_items')
      .where({ id })
      .whereNull('deleted_at')
      .update({ deleted_at: new Date() });

    if (updated === 0) {
      res.status(404).json({ code: -1, message: '食物不存在或已删除' });
      return;
    }

    res.json({ code: 0, message: '已删除' });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * PATCH /api/v1/inventory/:id
 * 更新食物信息（手动修正）
 */
inventoryRouter.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const allowedFields = ['name', 'quantity', 'unit', 'expiry_date', 'storage_location', 'category'];
    const updates: Record<string, any> = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ code: -1, message: '没有可更新的字段' });
      return;
    }

    updates.updated_at = new Date();

    const db = getDb();
    const [updated] = await db('food_items')
      .where({ id })
      .whereNull('deleted_at')
      .update(updates)
      .returning('*');

    if (!updated) {
      res.status(404).json({ code: -1, message: '食物不存在或已删除' });
      return;
    }

    res.json({ code: 0, data: updated });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});
