import axios from 'axios';
import { config } from '../config';

export interface FoodItem {
  name: string;
  quantity: number;
  unit: string;
  estimated_expiry_days: number;
}

const SYSTEM_PROMPT = `你是一个精准的家庭食物识别专家。请分析这张图片，返回其中的所有食物。严格按照以下JSON Schema返回，不要包含任何其他文字或Markdown标记：[{"name": "中文名称", "quantity": 数字, "unit": "个/克/毫升", "estimated_expiry_days": 数字(从今天算起) }]`;

/**
 * 调用 LMStudio 视觉模型识别食物
 */
export async function recognizeFood(imageBase64: string): Promise<FoodItem[]> {
  // 去除 data:image/xxx;base64, 前缀
  const pureBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

  const payload = {
    model: config.lmstudio.model,
    messages: [
      {
        role: 'user',
        content: SYSTEM_PROMPT,
        images: [pureBase64],
      },
    ],
    stream: false,
    options: {
      temperature: 0.1,
    },
  };

  try {
    const response = await axios.post(
      `${config.lmstudio.host}/api/chat`,
      payload,
      { timeout: config.lmstudio.timeout }
    );

    const content = response.data?.message?.content || response.data?.choices?.[0]?.message?.content || '';
    return parseAIResponse(content);
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') {
      throw new Error('LMStudio 请求超时（60秒），模型可能正在加载中');
    }
    throw new Error(`LMStudio 调用失败: ${error.message}`);
  }
}

/**
 * 解析 AI 返回的 JSON，兼容常见格式问题
 */
function parseAIResponse(content: string): FoodItem[] {
  // 尝试直接解析
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
      }));
  } catch {
    throw new Error(`AI 返回格式解析失败: ${content.substring(0, 200)}`);
  }
}
