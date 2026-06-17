/**
 * 食物品类默认保质期字典（天数）
 * 当 AI 未返回 estimated_expiry_days 时，用作降级策略
 */

export type FoodCategory = 'VEGETABLE' | 'FRUIT' | 'MEAT' | 'DAIRY' | 'SEASONING' | 'BEVERAGE' | 'OTHER';

interface CategoryInfo {
  defaultExpiryDays: number;
  storageLocation: string;
  keywords: string[];
}

export const FOOD_CATEGORY_MAP: Record<FoodCategory, CategoryInfo> = {
  VEGETABLE: {
    defaultExpiryDays: 7,
    storageLocation: 'FRIDGE',
    keywords: ['菜', '瓜', '豆', '茄', '椒', '菠菜', '白菜', '西兰花', '芹菜', '生菜', '萝卜', '土豆', '番茄', '洋葱', '蘑菇'],
  },
  FRUIT: {
    defaultExpiryDays: 5,
    storageLocation: 'FRIDGE',
    keywords: ['果', '莓', '苹果', '香蕉', '橙', '梨', '桃', '葡萄', '芒果', '西瓜', '草莓', '蓝莓', '柠檬'],
  },
  MEAT: {
    defaultExpiryDays: 3,
    storageLocation: 'FRIDGE',
    keywords: ['肉', '鸡', '牛', '猪', '羊', '鱼', '虾', '蟹', '排骨', '鸡翅', '培根', '香肠', '火腿'],
  },
  DAIRY: {
    defaultExpiryDays: 14,
    storageLocation: 'FRIDGE',
    keywords: ['奶', '酸奶', '牛奶', '芝士', '奶酪', '黄油', '酥油', '鸡蛋', '蛋'],
  },
  SEASONING: {
    defaultExpiryDays: 180,
    storageLocation: 'PANTRY',
    keywords: ['酱', '醋', '油', '盐', '糖', '料酒', '酱油', '蚝油', '辣椒', '花椒', '八角', '香料'],
  },
  BEVERAGE: {
    defaultExpiryDays: 90,
    storageLocation: 'PANTRY',
    keywords: ['水', '茶', '咖啡', '果汁', '可乐', '啤酒', '饮料', '汽水', '矿泉水'],
  },
  OTHER: {
    defaultExpiryDays: 30,
    storageLocation: 'PANTRY',
    keywords: [],
  },
};

/**
 * 根据食物名称自动推断品类
 */
export function inferCategory(foodName: string): FoodCategory {
  for (const [category, info] of Object.entries(FOOD_CATEGORY_MAP)) {
    if (info.keywords.some((kw) => foodName.includes(kw))) {
      return category as FoodCategory;
    }
  }
  return 'OTHER';
}

/**
 * 获取食物默认保质期天数
 */
export function getDefaultExpiryDays(foodName: string): number {
  const category = inferCategory(foodName);
  return FOOD_CATEGORY_MAP[category].defaultExpiryDays;
}

/**
 * 获取食物推荐存储位置
 */
export function getDefaultStorageLocation(foodName: string): string {
  const category = inferCategory(foodName);
  return FOOD_CATEGORY_MAP[category].storageLocation;
}
