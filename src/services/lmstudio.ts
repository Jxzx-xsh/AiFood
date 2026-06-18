import axios from 'axios';
import { config } from '../config';

const MAX_RETRIES = 6;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无请求后卸载模型

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== 模型生命周期管理 ==========

let idleTimer: NodeJS.Timeout | null = null;
let modelLoaded = false;

/**
 * 加载视觉模型到 LMStudio
 */
async function loadModel(): Promise<void> {
  if (modelLoaded) return;

  console.log(`🔄 正在加载模型: ${config.lmstudio.model} ...`);
  try {
    await axios.post(
      `${config.lmstudio.host}/api/v1/models/load`,
      {
        model: config.lmstudio.model,
        context_length: 4096,
      },
      { timeout: 120000 } // 加载可能需要较长时间
    );
    modelLoaded = true;
    console.log(`✅ 模型已加载: ${config.lmstudio.model}`);
  } catch (error: any) {
    // 如果模型已经加载了，忽略错误
    if (error.response?.data?.error?.message?.includes('already loaded')) {
      modelLoaded = true;
      console.log(`✅ 模型已在内存中: ${config.lmstudio.model}`);
      return;
    }
    console.error(`❌ 模型加载失败: ${error.message}`);
    throw new Error(`模型加载失败: ${error.message}`);
  }
}

/**
 * 卸载视觉模型，释放内存
 */
async function unloadModel(): Promise<void> {
  if (!modelLoaded) return;

  console.log(`💤 空闲超时，正在卸载模型: ${config.lmstudio.model} ...`);
  try {
    await axios.post(
      `${config.lmstudio.host}/api/v1/models/unload`,
      { instance_id: config.lmstudio.model },
      { timeout: 30000 }
    );
    modelLoaded = false;
    console.log(`✅ 模型已卸载，内存已释放`);
  } catch (error: any) {
    console.error(`❌ 模型卸载失败: ${error.message}`);
    modelLoaded = false; // 标记为未加载，下次会重新加载
  }
}

/**
 * 重置空闲计时器（每次请求后调用）
 */
function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    unloadModel();
  }, IDLE_TIMEOUT_MS);
}

// ========== 食物识别接口 ==========

export interface FoodItem {
  name: string;
  quantity: number;
  unit: string;
  estimated_expiry_days: number;
  production_date?: string;
  expiry_date?: string;
  shelf_life_days?: number;
  best_before_date?: string;
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
 * 自动管理模型生命周期：请求时加载，空闲5分钟后卸载
 */
export async function recognizeFood(imageBase64: string): Promise<FoodItem[]> {
  // 1. 确保模型已加载
  await loadModel();

  // 2. 构建请求
  const imageUrl = imageBase64.startsWith('data:image')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const payload = {
    model: config.lmstudio.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SYSTEM_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
    stream: false,
  };

  // 3. 调用模型
  try {
    const response = await axios.post(
      `${config.lmstudio.host}/v1/chat/completions`,
      payload,
      { timeout: config.lmstudio.timeout }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';

    // 4. 成功后重置空闲计时器
    resetIdleTimer();

    return parseAIResponse(content);
  } catch (error: any) {
    if (error.code === 'ECONNABORTED') {
      resetIdleTimer();
      throw new Error('LMStudio 请求超时，模型可能正在处理中');
    }
    // 模型未加载 — 可能刚被卸载，重新加载后重试
    if (error.response?.status === 400 && error.response?.data?.error?.message?.includes('No models loaded')) {
      modelLoaded = false;
      console.log('⏳ 模型未就绪，正在重新加载...');
      await loadModel();
      return recognizeFoodWithRetry(payload, MAX_RETRIES - 1);
    }
    if (error.response) {
      throw new Error(`LMStudio 返回错误 ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`LMStudio 调用失败: ${error.message}`);
  }
}

/**
 * 带重试的模型调用
 */
async function recognizeFoodWithRetry(payload: any, retriesLeft: number): Promise<FoodItem[]> {
  try {
    const response = await axios.post(
      `${config.lmstudio.host}/v1/chat/completions`,
      payload,
      { timeout: config.lmstudio.timeout }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    resetIdleTimer();
    return parseAIResponse(content);
  } catch (error: any) {
    if (error.response?.status === 400 && error.response?.data?.error?.message?.includes('No models loaded')) {
      if (retriesLeft <= 0) {
        throw new Error('LMStudio 模型持续未加载，已达最大重试次数');
      }
      console.log(`⏳ 模型加载中，等待 15 秒后重试 (剩余 ${retriesLeft} 次)...`);
      await sleep(15000);
      return recognizeFoodWithRetry(payload, retriesLeft - 1);
    }
    throw error;
  }
}

/**
 * 解析 AI 返回的 JSON，兼容常见格式问题
 */
function parseAIResponse(content: string): FoodItem[] {
  let cleaned = content.trim();

  cleaned = cleaned.replace(/^```json?\s*\n?/, '').replace(/\n?```\s*$/, '');

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleaned = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);
    const items: FoodItem[] = Array.isArray(parsed) ? parsed : [parsed];

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
