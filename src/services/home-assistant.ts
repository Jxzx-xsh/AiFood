import axios from 'axios';
import { config } from '../config';

interface ExpiringItem {
  name: string;
  expiry_date: string;
  days_left: number;
}

/**
 * 更新 HA 传感器状态
 */
export async function updateHASensor(
  familyPrefix: string,
  expiringItems: ExpiringItem[]
): Promise<void> {
  if (!config.homeAssistant.token) {
    console.warn('⚠️ HA Token 未配置，跳过传感器更新');
    return;
  }

  const entityId = `sensor.${familyPrefix}_food_expiring_soon`;
  const stateMessage =
    expiringItems.length === 0
      ? '所有食物状态良好'
      : expiringItems.map((i) => `${i.name}(${i.days_left}天)`).join('、') + ' 即将过期';

  const payload = {
    state: stateMessage,
    attributes: {
      items: expiringItems,
      count: expiringItems.length,
      friendly_name: '即将过期食物',
      icon: 'mdi:food-apple-outline',
      unit_of_measurement: '项',
      last_updated: new Date().toISOString(),
    },
  };

  try {
    await axios.post(
      `${config.homeAssistant.url}/api/states/${entityId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.homeAssistant.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`✅ HA 传感器已更新: ${entityId} (${expiringItems.length} 项即将过期)`);
  } catch (error: any) {
    console.error(`❌ HA 传感器更新失败: ${error.message}`);
  }
}

/**
 * 发送 HA 通知
 */
export async function sendHANotification(
  title: string,
  message: string,
  target: string = 'notify.mobile_app_iphone'
): Promise<void> {
  if (!config.homeAssistant.token) return;

  try {
    await axios.post(
      `${config.homeAssistant.url}/api/services/${target.replace('.', '/')}`,
      { title, message },
      {
        headers: {
          Authorization: `Bearer ${config.homeAssistant.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    console.log(`📱 HA 通知已发送: ${title}`);
  } catch (error: any) {
    console.error(`❌ HA 通知发送失败: ${error.message}`);
  }
}
