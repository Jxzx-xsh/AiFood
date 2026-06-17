import { Router, Request, Response } from 'express';
import { getDb } from '../database/connection';

export const recipeRouter = Router();

/**
 * GET /api/v1/recipes/recommend?family_id={id}
 * 基于当前库存推荐食谱
 */
recipeRouter.get('/recommend', async (req: Request, res: Response): Promise<void> => {
  try {
    const { family_id } = req.query;
    if (!family_id) {
      res.status(400).json({ code: -1, message: '缺少 family_id 参数' });
      return;
    }

    const db = getDb();

    // 获取当前有效库存食材名称
    const today = new Date().toISOString().split('T')[0];
    const inventory = await db('food_items')
      .where({ family_id })
      .whereNull('deleted_at')
      .where('expiry_date', '>=', today)
      .select('name');

    const inventoryNames = inventory.map((i) => i.name);

    if (inventoryNames.length === 0) {
      res.json({ code: 0, data: { recipes: [], message: '库存为空，无法推荐' } });
      return;
    }

    // 查询食谱，计算匹配度
    const recipes = await db('recipes').select('*');

    const scored = recipes
      .map((recipe) => {
        const ingredients: Array<{ name: string }> = recipe.ingredients || [];
        const requiredNames = ingredients.map((ing) => ing.name);
        const matched = requiredNames.filter((name) =>
          inventoryNames.some((inv) => inv.includes(name) || name.includes(inv))
        );
        const matchRate = requiredNames.length > 0 ? matched.length / requiredNames.length : 0;
        const missing = requiredNames.filter(
          (name) => !inventoryNames.some((inv) => inv.includes(name) || name.includes(inv))
        );

        return {
          ...recipe,
          match_rate: Math.round(matchRate * 100),
          matched_ingredients: matched,
          missing_ingredients: missing,
        };
      })
      .filter((r) => r.match_rate > 0)
      .sort((a, b) => b.match_rate - a.match_rate)
      .slice(0, 10);

    res.json({ code: 0, data: { recipes: scored, inventory_count: inventoryNames.length } });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * GET /api/v1/recipes
 * 获取全部食谱
 */
recipeRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDb();
    const recipes = await db('recipes').select('*').orderBy('name');
    res.json({ code: 0, data: { recipes, total: recipes.length } });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});

/**
 * POST /api/v1/recipes
 * 添加食谱
 */
recipeRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, ingredients, steps, cuisine, tags } = req.body;

    if (!name || !ingredients) {
      res.status(400).json({ code: -1, message: '缺少 name 或 ingredients' });
      return;
    }

    const db = getDb();
    const [recipe] = await db('recipes')
      .insert({ name, ingredients: JSON.stringify(ingredients), steps, cuisine, tags })
      .returning('*');

    res.status(201).json({ code: 0, data: recipe });
  } catch (error: any) {
    res.status(500).json({ code: -99, message: error.message });
  }
});
