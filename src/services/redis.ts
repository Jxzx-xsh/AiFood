import Redis from 'ioredis';
import { config } from '../config';

let redisClient: Redis | null = null;

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redis.url);
    redisClient.on('error', (err) => {
      console.error('❌ Redis connection error:', err.message);
    });
    redisClient.on('connect', () => {
      console.log('✅ Redis connected');
    });
  }
  return redisClient;
}

// 库存缓存 key 生成
export function inventoryCacheKey(familyId: string): string {
  return `inventory:${familyId}`;
}

// 缓存过期食物快照
export async function cacheExpiringItems(familyId: string, items: unknown[]): Promise<void> {
  const redis = getRedis();
  const key = `expiring:${familyId}`;
  await redis.set(key, JSON.stringify(items), 'EX', 3600); // 1小时TTL
}

// 清除库存缓存
export async function invalidateInventoryCache(familyId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(inventoryCacheKey(familyId));
  await redis.del(`expiring:${familyId}`);
}
