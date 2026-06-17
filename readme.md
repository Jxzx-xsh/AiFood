好的，基于我们确认的方案（**iPhone快捷指令拍照 → Node.js后端 → Mac mini本地LMStudio视觉模型 → PostgreSQL/Redis → HA集成**），我为你整理了一份完整的**系统开发文档**。

这份文档侧重于**接口定义**、**数据模型**、**配置规范**和**实现逻辑流程图**，不包含具体的代码实现，方便你或团队直接按此文档进行编码。

---

# 项目开发文档：家庭AI食物管家（AI Food）

**版本**：v1.0
**日期**：2026-06-17
**架构原则**：本地优先（Local-First）、无额外App开发、高隐私安全

---

## 1. 系统概述与核心目标

- **输入源**：iPhone 原生相机 / 相册（通过Apple快捷指令触发）。
- **AI引擎**：Mac mini 本地运行 LMStudio + 多模态视觉模型（Llama 3.2-Vision）。
- **业务中枢**：Node.js (TypeScript) + PostgreSQL + Redis。
- **展示与控制**：Home Assistant (HA) 仪表盘 + iOS家庭App（通过HA Bridge）。
- **核心目标**：
  1. 拍照即录入，自动识别食物品名、数量与预估保质期。
  2. 库存过期自动巡检，提前N天推送HA提醒。
  3. 支持基于库存食材的食谱推荐。

---

## 2. 技术栈与环境要求

### 2.1 硬件环境
- **Mac mini**：建议 M1 芯片及以上，内存 ≥ 16GB（推荐 32GB 以运行 11B-90B 模型）。
- **家庭服务器**：运行 Node.js、PostgreSQL、Redis 的设备（可与 Mac mini 同一台，或单独 NAS/Docker 主机）。
- **iPhone**：iOS 16+（支持快捷指令 Base64 编码与网络请求）。

### 2.2 软件依赖
| 组件 | 版本/方案 | 用途 |
| :--- | :--- | :--- |
| **Node.js** | v20.x LTS | 后端运行时 |
| **TypeScript** | v5.x | 开发语言 |
| **PostgreSQL** | v15+ | 结构化数据存储（食物、家庭、食谱） |
| **Redis** | v7+ | 缓存（库存快照）、Bull消息队列（定时任务） |
| **LMStudio** | Latest | Mac mini 本地模型服务 |
| **Vision Model** | `llama3.2-vision:11b` (基准) / `llama3.2-vision:90b` (高阶) | 图像识别与语义解析 |
| **Home Assistant** | 2024.6+ | 家庭自动化中枢 |

---

## 3. 数据库设计（DDL 核心结构）

### 3.1 家庭与食物表
```sql
-- 家庭/用户组（用于多家庭隔离）
CREATE TABLE families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    ha_entity_prefix VARCHAR(50) UNIQUE, -- 如 'family_kitchen'
    created_at TIMESTAMP DEFAULT NOW()
);

-- 食物库存主表
CREATE TABLE food_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    
    -- 核心识别字段
    name VARCHAR(100) NOT NULL,          -- 标准化名称，如 "西兰花"
    original_name VARCHAR(100),          -- OCR/AI识别的原始名称
    category VARCHAR(20),                -- 枚举: VEGETABLE, FRUIT, MEAT, DAIRY, SEASONING, BEVERAGE, OTHER
    
    -- 数量与单位
    quantity DECIMAL(10, 2) DEFAULT 1,
    unit VARCHAR(10) DEFAULT '个',       -- 个, 克, 毫升, 盒, 袋
    
    -- 时间轴
    purchase_date DATE DEFAULT CURRENT_DATE,
    expiry_date DATE NOT NULL,           -- 关键字段，必须计算得出
    days_to_expiry INT,                  -- 冗余字段（生成列或由代码维护），用于快速查询
    
    -- 元数据
    storage_location VARCHAR(20),        -- FRIDGE, FREEZER, PANTRY
    source VARCHAR(20),                  -- PHOTO, RECEIPT, TEXT, MANUAL
    image_url TEXT,                      -- 缩略图存储路径（MinIO/S3）
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引以加速过期扫描
CREATE INDEX idx_food_expiry ON food_items (family_id, expiry_date) WHERE deleted_at IS NULL;
```

### 3.2 食谱库（推荐用）
```sql
CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    ingredients JSONB NOT NULL,          -- [{"name": "鸡蛋", "amount": 2, "unit": "个"}]
    steps TEXT[],
    cuisine VARCHAR(20),
    tags VARCHAR(20)[]                   -- 如 ['quick', 'vegetarian']
);
```

---

## 4. API 接口规范（前后端与快捷指令约定）

所有接口前缀为 `/api/v1`，请求头需携带 `X-API-Key`（内网简单认证，防泄漏）。

### 4.1 图片录入接口（核心）
**Endpoint**: `POST /ingest/photo`

**Request Body**:
```json
{
  "family_id": "uuid-string",
  "image_base64": "data:image/jpeg;base64,/9j/4AAQ...",
  "shoot_time": "2026-06-17T10:00:00Z" // 可选，用于推算购买时间
}
```

**Processing Logic** (Node.js 后端逻辑):
1. 校验图片大小（限制 < 10MB）。
2. 将 `image_base64` 中的纯 Base64 字符串提取出来。
3. 调用 Mac mini LMStudio API（见第 5 节）。
4. 解析 AI 返回的 JSON，校验字段完整性。
5. 若 AI 未返回 `expiry_date`，则根据 `purchase_date` + 食物品类默认保质期（来自字典表）推算。
6. 写入 PostgreSQL，更新 Redis 库存缓存，触发 HA 传感器同步。

**Success Response (200)**:
```json
{
  "code": 0,
  "data": {
    "parsed_items": [
      { "name": "番茄", "quantity": 3, "unit": "个", "expiry_date": "2026-06-24" }
    ],
    "total_saved": 1,
    "ai_raw_response": "I see tomatoes..." // Debug用
  }
}
```

### 4.2 库存查询与状态接口
**Endpoint**: `GET /inventory/expiring?family_id={id}&days=3`
**Response**: 返回未来 N 天内即将过期的食物列表。

### 4.3 HA 状态同步接口（由 Node.js 主动调用 HA）
*此接口非外部调用，而是 Node.js 内调用 HA REST API。*
- **Method**: `POST /api/states/sensor.food_expiring_soon`
- **Payload**: 
  ```json
  { "state": "牛奶、鸡蛋即将过期", "attributes": { "items": [...], "count": 2 } }
  ```

---

## 5. Mac mini 本地大模型调用规范

### 5.1 LMStudio API 地址
- `http://{MAC_MINI_IP}:11434/api/chat`

### 5.2 请求 Payload 模板（Node.js 需严格遵守）
```json
{
  "model": "llama3.2-vision:11b",
  "messages": [
    {
      "role": "user",
      "content": "你是一个精准的家庭食物识别专家。请分析这张图片，返回其中的所有食物。严格按照以下JSON Schema返回，不要包含任何其他文字或Markdown标记：[{\"name\": \"中文名称\", \"quantity\": 数字, \"unit\": \"个/克/毫升\", \"estimated_expiry_days\": 数字(从今天算起) }]",
      "images": ["此处为纯Base64字符串（不含data:image前缀）"]
    }
  ],
  "stream": false,
  "options": {
    "temperature": 0.1  // 低温度保证格式稳定性
  }
}
```

### 5.3 异常处理机制
- **超时设置**：请求超时设为 60 秒（视觉模型推理较慢）。
- **降级策略**：若 AI 返回的 JSON 解析失败，将图片存储至待处理队列，发送通知给用户手动修正。

---

## 6. iOS 快捷指令（Shortcuts）配置说明书

无需开发 App，直接在 iPhone 上配置快捷指令。

1. **新建快捷指令** -> 命名：“录入食物”。
2. **添加操作 - 拍摄照片**（或选择照片）。
3. **添加操作 - Base64 编码**（输入为刚获取的图片）。
4. **添加操作 - 获取日期**（获取当前时间，ISO 8601 格式）。
5. **添加操作 - 获取 URL 内容**：
   - **方式**：POST
   - **URL**：`https://你的域名或内网IP:3000/api/v1/ingest/photo`
   - **头部**：添加 `X-API-Key: your_secret_key`
   - **请求体**：选择 JSON，填入以下格式：
     ```json
     {
       "family_id": "你的家庭UUID",
       "image_base64": "data:image/jpeg;base64,（拖入Base64编码的变量）",
       "shoot_time": "（拖入日期变量）"
     }
     ```
6. **完成**：关闭“显示更多”，添加“显示通知”以反馈成功/失败状态。

---

## 7. Home Assistant 集成规范

### 7.1 Node.js 端 HA 客户端配置
- 环境变量：`HA_URL="http://homeassistant.local:8123"`, `HA_TOKEN="eyJhbGci..."`。
- 利用 `axios` 向 HA 发送状态更新。

### 7.2 自动化触发设计（HA 侧 YAML 逻辑）
- **触发器**：`sensor.food_expiring_soon` 状态变更，或每天早上 8 点轮询。
- **动作**：
  1. 调用 `notify.mobile_app_iphone` 推送消息。
  2. 调用 `media_player` TTS 语音播报（如厨房小爱音箱）。
  3. 暴露给 HomeKit：将 `sensor` 转为 HomeKit 可读的 `text` 传感器，即可在 iOS “家庭” App 中查看提醒卡片。

---

## 8. 环境变量配置清单 (.env)

请创建 `.env` 文件并配置以下密钥：

```ini
# Server
PORT=3000
NODE_ENV=production
API_KEY=your_very_strong_random_string

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=food_mgr

# Redis
REDIS_URL=redis://localhost:6379

# LMStudio (Mac Mini)
LMStudio_HOST=http://192.168.1.100:11434  # 替换为 Mac mini 内网 IP
VISION_MODEL=llama3.2-vision:11b

# Home Assistant
HA_URL=http://192.168.1.200:8123
HA_TOKEN=eyJhbGciOiJIUzI1NiIs...

# File Storage (可选)
MINIO_ENDPOINT=localhost:9000
```

---

## 9. 部署与运维指引

1. **数据库迁移**：使用 TypeORM 或 Knex 运行上述 DDL 脚本。
2. **启动 Node 服务**：推荐使用 `pm2` 守护进程。
3. **Mac mini 保活**：
   ```bash
   # 设置 LMStudio 开机自启
   brew services start LMStudio
   # 主动拉取模型（提前下载，避免首次调用超时）
   LMStudio pull llama3.2-vision:11b
   ```
4. **内网穿透（可选）**：如果 iPhone 在外网时也想用，需配置路由器端口转发或 Tailscale VPN（不建议直接暴露 3000 端口到公网，除非加 HTTPS 与反向代理）。

---

## 10. 开发阶段划分（Sprint 建议）

- **Sprint 1（基础骨架）**：搭建 Node.js + TypeScript 工程，连接 PostgreSQL/Redis，实现 `POST /ingest/photo` 的空壳（Mock 数据）。
- **Sprint 2（AI 接入）**：实现 LMStudio Client 封装，调试 `llama3.2-vision` 的返回解析，完善过期日期计算逻辑。
- **Sprint 3（快捷指令联调）**：iPhone 端配置指令，端到端测试图片上传 -> 识别 -> 入库全流程。
- **Sprint 4（HA 联动）**：实现 HA Sensor 更新、自动化提醒配置。
- **Sprint 5（增强功能）**：加入本地食谱推荐引擎（基于现有库存匹配 Recipe 表）。

---

此文档已覆盖系统设计全貌，所有模块解耦清晰。你可以依照此文档，分别从 **Node.js 层**、**HA 配置层**、**快捷指令层** 开始并行开发。如果在具体实现中遇到 LMStudio 模型输出格式不稳定的情况，可以在 Prompt 中强化 `temperature=0` 并辅以代码层的 `JSON.parse` 异常捕获与重试。