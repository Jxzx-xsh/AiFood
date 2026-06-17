import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // 清空现有数据
  await knex('food_items').del();
  await knex('families').del();

  // 插入默认家庭
  await knex('families').insert({
    id: '00000000-0000-0000-0000-000000000001',
    name: '我的家庭',
    ha_entity_prefix: 'family_kitchen',
  });
}
