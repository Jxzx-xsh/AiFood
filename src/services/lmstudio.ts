import axios from 'axios';
import { config } from '../config';

export interface FoodItem {
  name: string;
  quantity: number;
  unit: string;
  estimated_expiry_days: number;
  production_date?: string;    // 生产日期 (YYYY-MM-DD)
  expiry_date?: string;        // 包装标注的过期日期 (YYYY-MM-DD)
  shelf_life_days?: number;    // 包装标注的保质期天数
  best_before_date?: string;   // 建议食用日期 (YYYY-MM-DD)
}

const SYSTEM_PROMPT = `你是一个精准的家庭食物识别专家。请分析这张图片中的食物信息。

图片可能是：食物实物照片、购物小票、食品包装（含生产日期/保质期）。

请尽可能识别以下信息，严格按照JSON Schema返回，不要包含任何其他文字或Markdown标记：

[{
  "name": "中文名称",
  "quantity": 数字,
  "unit": "个/克/毫升/盒/袋",
  "production_date": "生产日期(YYYY-MM-DD格式，如能识别)",
  "expiry_date": "过期日期(YYYY-MM-DD格式，如能从包装/小票识别)",
  "shelf_life_days": "保质期天数(如包装标注'保质期12个月'则为365)",
  "estimated_expiry_days": "若无法识别具体日期，估算从今天起的剩余天数"
}]

重要规则：
1. 如果能从小票或包装上识别到明确的生产日期和保质期，优先使用这些信息
2. 如果能直接识别到过期日期(如"有效期至2026-08-01")，直接填入expiry_date
3. 如果只能看到保质期天数(如"保质期180天")和生产日期，同时填入两者
4. 如果都无法识别，则根据食物品类估算estimated_expiry_days
5. 小票上的日期通常是购买日期，可作为参考`;

/**
 * 调用 LMStudio 视觉模型识别食物
 * LMStudio 使用 OpenAI 兼容 API 格式
 */
export async function recognizeFood(imageBase64: string): Promise<FoodItem[]> {
  // 确保有 data:image 前缀
  const imageUrl = imageBase64.startsWith('data:image')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const payload = {
    model: config.lmstudio.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
          },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
    stream: false,
  };

  try {
    const response = await axios.post(
      `${config.lmstudio.host}/v1/chat/completions`,
      payload,
      { timeout: config.lmstudio.timeout }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    return parseAIResponse(content);
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') {
      throw new Error('LMStudio 请求超时（60秒），模型可能正在加载中');
    }
    if (error.response) {
      throw new Error(`LMStudio 返回错误 ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`LMStudio 调用失败: ${error.message}`);
  }
}

/**
 * 解析 AI 返回的 JSON，兼容常见格式问题
 */
function parseAIResponse(content: string): FoodItem[] {
  let cleaned = content.trim();

  // 去除可能的 markdown 代码块标记
  cleaned = cleaned.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');

  // 尝试提取 JSON 数组
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleaned = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);
    const items: FoodItem[] = Array.isArray(parsed) ? parsed : [parsed];

    // 校验每个项目的基本字段
    return items
      .filter((item) => item.name && typeof item.name === 'string')
      .map((item) => ({
        name: item.name.trim(),
        quantity: Number(item.quantity) || 1,
        unit: item.unit || '个',
        estimated_expiry_days: Number(item.estimated_expiry_days) || 7,
        production_date: item.production_date || undefined,
        expiry_date: item.expiry_date || undefined,
        shelf_life_days: item.shelf_life_days ? Number(item.shelf_life_days) : undefined,
        best_before_date: item.best_before_date || undefined,
      }));
  } catch {
    throw new Error(`AI 返回格式解析失败: ${content.substring(0, 200)}`);
  }
}
