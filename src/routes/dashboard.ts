import { Router, Request, Response } from 'express';
import { getDb } from '../database/connection';

export const dashboardRouter = Router();

/**
 * GET /dashboard
 * 简单的库存查看页面（手机浏览器直接访问）
 */
dashboardRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const items = await db('food_items')
      .whereNull('deleted_at')
      .orderBy('expiry_date', 'asc')
      .select('*');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🍎 食物管家</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #f5f5f7; padding: 16px; }
    h1 { font-size: 24px; margin-bottom: 16px; text-align: center; }
    .stats { display: flex; gap: 8px; margin-bottom: 16px; justify-content: center; flex-wrap: wrap; }
    .stat { background: white; padding: 12px 16px; border-radius: 12px; text-align: center; min-width: 80px; }
    .stat-num { font-size: 24px; font-weight: bold; }
    .stat-label { font-size: 12px; color: #666; }
    .item { background: white; padding: 14px 16px; border-radius: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    .item-name { font-size: 16px; font-weight: 500; }
    .item-meta { font-size: 13px; color: #666; }
    .item-expiry { font-size: 13px; text-align: right; }
    .expired { color: #ff3b30; font-weight: bold; }
    .expiring { color: #ff9500; font-weight: bold; }
    .fresh { color: #34c759; }
    .category-tag { font-size: 11px; background: #e8e8ed; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
    .empty { text-align: center; color: #999; padding: 40px; }
  </style>
</head>
<body>
  <h1>🍎 食物管家</h1>
  <div class="stats">
    <div class="stat">
      <div class="stat-num">${items.length}</div>
      <div class="stat-label">总计</div>
    </div>
    <div class="stat">
      <div class="stat-num expired">${items.filter(i => i.expiry_date < today).length}</div>
      <div class="stat-label">已过期</div>
    </div>
    <div class="stat">
      <div class="stat-num expiring">${items.filter(i => {
        const d = Math.ceil((new Date(i.expiry_date).getTime() - new Date().getTime()) / 86400000);
        return d >= 0 && d <= 3;
      }).length}</div>
      <div class="stat-label">即将过期</div>
    </div>
    <div class="stat">
      <div class="stat-num fresh">${items.filter(i => {
        const d = Math.ceil((new Date(i.expiry_date).getTime() - new Date().getTime()) / 86400000);
        return d > 3;
      }).length}</div>
      <div class="stat-label">新鲜</div>
    </div>
  </div>

  ${items.length === 0 ? '<div class="empty">暂无食物，拍照录入吧 📷</div>' : ''}

  ${items.map(item => {
    const daysLeft = Math.ceil((new Date(item.expiry_date).getTime() - new Date().getTime()) / 86400000);
    let statusClass = 'fresh';
    let statusText = `${daysLeft}天后到期`;
    if (daysLeft < 0) { statusClass = 'expired'; statusText = `已过期${Math.abs(daysLeft)}天`; }
    else if (daysLeft === 0) { statusClass = 'expired'; statusText = '今天到期'; }
    else if (daysLeft <= 3) { statusClass = 'expiring'; statusText = `${daysLeft}天后到期`; }

    const categoryMap: Record<string, string> = { VEGETABLE: '蔬菜', FRUIT: '水果', MEAT: '肉类', DAIRY: '乳制品', SEASONING: '调味品', BEVERAGE: '饮料', OTHER: '其他' };
    const categoryName = categoryMap[item.category] || '其他';

    return `<div class="item">
      <div>
        <div class="item-name">${item.name}<span class="category-tag">${categoryName}</span></div>
        <div class="item-meta">${item.quantity}${item.unit} · ${item.storage_location === 'FRIDGE' ? '🧊冰箱' : item.storage_location === 'FREEZER' ? '❄️冷冻' : '🗄️储物柜'}</div>
      </div>
      <div class="item-expiry">
        <div class="${statusClass}">${statusText}</div>
        <div style="font-size:11px;color:#999">${item.expiry_date.split('T')[0]}</div>
      </div>
    </div>`;
  }).join('')}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`Error: ${error.message}`);
  }
});
