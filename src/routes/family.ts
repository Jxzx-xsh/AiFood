import { Router, Request, Response } from 'express';
import { getDb } from '../database/connection';

export const familyRouter = Router();

/**
 * GET /api/v1/families
 * 获取全部家庭列表
 */
familyRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDb();
    const families = await db('families').select('*').orderBy('created_at');
    res.json({ code: 0, data: { families, total: families.length } });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * POST /api/v1/families
 * 创建新家庭
 */
familyRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, ha_entity_prefix } = req.body;

    if (!name) {
      res.status(400).json({ code: -1, message: '缺少 name 参数' });
      return;
    }

    const db = getDb();
    const [family] = await db('families')
      .insert({ name, ha_entity_prefix: ha_entity_prefix || null })
      .returning('*');

    res.status(201).json({ code: 0, data: family });
  } catch (error: any) {
    if (error.code === '23505') {
      res.status(409).json({ code: -1, message: 'ha_entity_prefix 已存在' });
      return;
    }
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * GET /api/v1/families/:id/stats
 * 获取家庭库存统计
 */
familyRouter.get('/:id/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const [total] = await db('food_items')
      .where({ family_id: id })
      .whereNull('deleted_at')
      .count('id as count');

    const [expiringSoon] = await db('food_items')
      .where({ family_id: id })
      .whereNull('deleted_at')
      .where('expiry_date', '>=', today)
      .where('expiry_date', '<=', db.raw("CURRENT_DATE + INTERVAL '3 days'"))
      .count('id as count');

    const [expired] = await db('food_items')
      .where({ family_id: id })
      .whereNull('deleted_at')
      .where('expiry_date', '<', today)
      .count('id as count');

    const categoryStats = await db('food_items')
      .where({ family_id: id })
      .whereNull('deleted_at')
      .groupBy('category')
      .select('category')
      .count('id as count');

    res.json({
      code: 0,
      data: {
        total: Number(total.count),
        expiring_soon: Number(expiringSoon.count),
        expired: Number(expired.count),
        by_category: categoryStats,
      },
    });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});
