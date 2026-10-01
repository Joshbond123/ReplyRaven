import { SCHEMA } from '../lib/core.js';
export class MemoryStore {
  constructor(data = {}) {
    this.data = Object.fromEntries(Object.keys(SCHEMA).map((tab) => [tab, structuredClone(data[tab] || [])]));
    this.writes = [];
  }
  async read(tab) {
    return structuredClone(this.data[tab]).map((row, index) => ({ ...row, _row: index + 2 }));
  }
  async update(tab, row) {
    this.data[tab][row._row - 2] = Object.fromEntries(
      SCHEMA[tab].map((key) => [key, String(row[key] ?? '')]),
    );
    this.writes.push({ tab, row });
  }
  async updateMany(tab, rows) {
    for (const row of rows) await this.update(tab, row);
  }
  async append(tab, rows) {
    this.data[tab].push(
      ...rows.map((row) => Object.fromEntries(SCHEMA[tab].map((key) => [key, String(row[key] ?? '')]))),
    );
  }
  async deleteRows(tab, rows) {
    [...new Set(rows)].sort((a, b) => b - a).forEach((row) => this.data[tab].splice(row - 2, 1));
  }
  async saveSettings(values) {
    for (const [key, value] of Object.entries(values)) {
      const row = this.data.Settings.find((row) => row.key === key);
      if (row) row.value = String(value);
      else this.data.Settings.push({ key, value: String(value) });
    }
  }
}
export const business = {
  google_account_id: '123',
  google_location_id: '456',
  business_name: 'A café',
  address: 'Main Street',
  is_auto_reply: 'TRUE',
  ai_prompt_template: '',
  total_reviews: '2',
  avg_rating: '4.5',
  status: 'ACTIVE',
  last_sync: '',
  unreplied_count: '2',
};
export const review = {
  google_review_id: 'r1',
  google_location_id: '456',
  business_name: 'A café',
  reviewer_name: 'Alice',
  star_rating: '5',
  comment: 'Loved it!',
  review_date: '2026-09-01T00:00:00Z',
  reply_comment: '',
  is_replied: 'FALSE',
  reply_date: '',
  is_auto_replied: 'FALSE',
  needs_attention: 'FALSE',
};
export const aiKey = {
  id: 'key-1',
  provider: 'openai',
  api_key: 'a-private-key',
  model_name: 'gpt-4o-mini',
  is_active: 'TRUE',
  request_count: '0',
  last_used_at: '',
};
export const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
export function remoteReview(row, extra = {}) {
  return {
    reviewId: row.google_review_id,
    starRating: ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'][Number(row.star_rating)],
    comment: row.comment,
    createTime: row.review_date,
    reviewer: { displayName: row.reviewer_name },
    ...extra,
  };
}
