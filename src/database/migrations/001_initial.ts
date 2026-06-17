import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 家庭表
  await knex.schema.createTable('families', (table) => {
    table.uuid('id').primary().defaultTo(knex.fn.uuid());
    table.string('name', 50).notNullable();
    table.string('ha_entity_prefix', 50).unique();
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 食物库存主表
  await knex.schema.createTable('food_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.fn.uuid());
    table.uuid('family_id').notNullable().references('id').inTable('families').onDelete('CASCADE');

    // 核心识别字段
    table.string('name', 100).notNullable();
    table.string('original_name', 100);
    table.string('category', 20); // VEGETABLE, FRUIT, MEAT, DAIRY, SEASONING, BEVERAGE, OTHER

    // 数量与单位
    table.decimal('quantity', 10, 2).defaultTo(1);
    table.string('unit', 10).defaultTo('个');

    // 时间轴
    table.date('purchase_date').defaultTo(knex.fn.now());
    table.date('expiry_date').notNullable();
    table.integer('days_to_expiry');

    // 元数据
    table.string('storage_location', 20); // FRIDGE, FREEZER, PANTRY
    table.string('source', 20); // PHOTO, RECEIPT, TEXT, MANUAL
    table.text('image_url');

    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
  });

  // 过期扫描索引
  await knex.schema.raw(
    'CREATE INDEX idx_food_expiry ON food_items (family_id, expiry_date) WHERE deleted_at IS NULL'
  );

  // 食谱库
  await knex.schema.createTable('recipes', (table) => {
    table.uuid('id').primary().defaultTo(knex.fn.uuid());
    table.string('name', 100).notNullable();
    table.jsonb('ingredients').notNullable(); // [{name, amount, unit}]
    table.specificType('steps', 'TEXT[]');
    table.string('cuisine', 20);
    table.specificType('tags', 'VARCHAR(20)[]');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('recipes');
  await knex.schema.dropTableIfExists('food_items');
  await knex.schema.dropTableIfExists('families');
}
