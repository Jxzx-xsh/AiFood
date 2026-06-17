// ========== 食物相关类型 ==========

export type FoodCategory = 'VEGETABLE' | 'FRUIT' | 'MEAT' | 'DAIRY' | 'SEASONING' | 'BEVERAGE' | 'OTHER';
export type StorageLocation = 'FRIDGE' | 'FREEZER' | 'PANTRY';
export type FoodSource = 'PHOTO' | 'RECEIPT' | 'TEXT' | 'MANUAL';

export interface FoodItem {
  id: string;
  family_id: string;
  name: string;
  original_name?: string;
  category?: FoodCategory;
  quantity: number;
  unit: string;
  purchase_date: string;
  expiry_date: string;
  days_to_expiry?: number;
  storage_location?: StorageLocation;
  source?: FoodSource;
  image_url?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// ========== 家庭相关类型 ==========

export interface Family {
  id: string;
  name: string;
  ha_entity_prefix?: string;
  created_at: string;
}

// ========== 食谱相关类型 ==========

export interface RecipeIngredient {
  name: string;
  amount: number;
  unit: string;
}

export interface Recipe {
  id: string;
  name: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  cuisine?: string;
  tags?: string[];
  created_at: string;
}

// ========== API 响应类型 ==========

export interface ApiResponse<T = unknown> {
  code: number;
  data?: T;
  message?: string;
}

// ========== AI 识别相关类型 ==========

export interface AIFoodResult {
  name: string;
  quantity: number;
  unit: string;
  estimated_expiry_days: number;
}

export interface IngestResult {
  parsed_items: Array<{
    name: string;
    quantity: number;
    unit: string;
    expiry_date: string;
  }>;
  total_saved: number;
  ai_raw_response: string;
}
