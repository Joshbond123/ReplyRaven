import { SCHEMA, rowValues, resourceId, isTrue } from '../lib/core.js';
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const sampleBusinesses = [
  ['willow', 'Willow & Oak Café', '214 Maple Street, Austin, TX', 214, 4.9, true],
  ['bloom', 'Bloom Dental Studio', '86 West Avenue, Austin, TX', 138, 4.8, true],
  ['table', 'The Good Table', '1200 East 6th Street, Austin, TX', 302, 4.7, false],
  ['north', 'Northside Fitness', '450 North Lamar Blvd, Austin, TX', 189, 4.9, true],
  ['haven', 'Haven Beauty Bar', '32 South Congress Ave, Austin, TX', 267, 4.8, true],
  ['atlas', 'Atlas Home Services', '710 Riverside Drive, Austin, TX', 174, 4.6, false],
];
const reviewers = [
  'Sophie Martinez',
  'James Wilson',
  'Emily Chen',
  'Michael Davis',
  'Olivia Brooks',
  'Daniel Kim',
  'Ava Thompson',
  'Noah Garcia',
  'Isabella Reed',
  'Liam Patel',
  'Charlotte Lee',
  'Lucas Anderson',
];
const comments = [
  'Such a lovely experience! The team made us feel welcome from the moment we walked in. Will definitely be back.',
  'A new neighborhood favorite. You can tell how much care goes into every little detail.',
  'Really impressed with the friendly service. Everything was exactly as described. Highly recommend!',
  'Great overall experience. A little busy when we arrived, but the staff were attentive and helpful.',
  'Five stars all the way. Thank you for going above and beyond!',
  'The space is beautiful and the service is even better. Already looking forward to our next visit.',
  'Unfortunately we had to wait longer than expected and no one explained the delay. I hope this improves.',
  'The staff were nice, but the experience did not quite meet my expectations this time.',
];
export function seedDemo() {
  const data = Object.fromEntries(Object.keys(SCHEMA).map((tab) => [tab, []]));
  sampleBusinesses.forEach(([id, name, address, count, rating, auto], b) => {
    data.Businesses.push({
      google_account_id: 'demo-account',
      google_location_id: id,
      business_name: name,
      address,
      is_auto_reply: auto ? 'TRUE' : 'FALSE',
      ai_prompt_template: '',
      total_reviews: String(count),
      avg_rating: String(rating),
      last_sync: hoursAgo(0.15 + b * 0.08),
      status: 'ACTIVE',
      unreplied_count: '7',
    });
    for (let i = 0; i < 24; i++) {
      const replied = i >= 7;
      const autoReply = replied && auto && i % 3 !== 0;
      const stars = i === 2 ? 2 : i === 5 ? 3 : i % 4 === 0 ? 4 : 5;
      data.Reviews.push({
        google_review_id: `sample-${id}-${i}`,
        google_location_id: id,
        business_name: name,
        reviewer_name: reviewers[(i + b * 2) % reviewers.length],
        star_rating: String(stars),
        comment: comments[stars <= 3 ? 6 + (i % 2) : (i + b) % 6],
        review_date: hoursAgo(
          [
            1, 4, 6, 9, 14, 21, 26, 27, 31, 50, 52, 70, 81, 82, 83, 88, 102, 114, 122, 140, 144, 150, 165,
            168,
          ][i] +
            b * 0.7,
        ),
        reply_comment: replied
          ? `Thank you for your kind words! We're so glad you enjoyed your experience at ${name}. We look forward to welcoming you back soon.`
          : '',
        is_replied: replied ? 'TRUE' : 'FALSE',
        reply_date: replied ? hoursAgo(i < 10 ? 0.1 + b * 0.03 : i * 6) : '',
        is_auto_replied: autoReply ? 'TRUE' : 'FALSE',
        needs_attention: !replied && stars <= 3 ? 'TRUE' : 'FALSE',
      });
    }
  });
  data.AI_Keys = [
    {
      id: 'demo-openai',
      provider: 'openai',
      api_key: 'demo-key-not-a-real-credential',
      is_active: 'TRUE',
      request_count: '248',
      last_used_at: hoursAgo(0.1),
      model_name: 'gpt-4o-mini',
    },
    {
      id: 'demo-gemini',
      provider: 'gemini',
      api_key: 'demo-key-not-a-real-credential',
      is_active: 'TRUE',
      request_count: '172',
      last_used_at: hoursAgo(0.2),
      model_name: 'gemini-2.5-flash',
    },
    {
      id: 'demo-groq',
      provider: 'groq',
      api_key: 'demo-key-not-a-real-credential',
      is_active: 'TRUE',
      request_count: '96',
      last_used_at: hoursAgo(0.4),
      model_name: 'llama-3.3-70b-versatile',
    },
  ];
  data.Settings = [
    { key: 'automation_enabled', value: 'TRUE' },
    { key: 'reply_delay_seconds', value: '2' },
    { key: 'max_replies_per_run', value: '100' },
  ];
  data.Logs = [
    {
      timestamp: hoursAgo(0.1),
      business_name: 'Willow & Oak Café',
      action: 'AUTO_REPLY',
      review_id: 'sample-willow-8',
      status: 'SUCCESS',
      details: 'A 5-star review received a warm reply.',
      stars: '5',
    },
    {
      timestamp: hoursAgo(0.15),
      business_name: 'Bloom Dental Studio',
      action: 'SYNC',
      review_id: '',
      status: 'SUCCESS',
      details: 'Reviews are up to date.',
      stars: '',
    },
    {
      timestamp: hoursAgo(0.2),
      business_name: 'Haven Beauty Bar',
      action: 'AUTO_REPLY',
      review_id: 'sample-haven-7',
      status: 'SUCCESS',
      details: 'A 4-star review received a warm reply.',
      stars: '4',
    },
    {
      timestamp: hoursAgo(0.3),
      business_name: 'Northside Fitness',
      action: 'SYNC',
      review_id: '',
      status: 'SUCCESS',
      details: 'Reviews are up to date.',
      stars: '',
    },
  ];
  return data;
}
export class DemoStore {
  constructor(storage = localStorage) {
    this.storage = storage;
    try {
      this.data = JSON.parse(storage.getItem('rr_demo_data')) || seedDemo();
    } catch {
      this.data = seedDemo();
    }
    this.persist();
  }
  persist() {
    this.storage.setItem('rr_demo_data', JSON.stringify(this.data));
  }
  async read(tab) {
    return structuredClone(this.data[tab]).map((row, i) => ({ ...row, _row: i + 2 }));
  }
  async append(tab, rows) {
    this.data[tab].push(
      ...rows.map((row) => Object.fromEntries(SCHEMA[tab].map((key, i) => [key, rowValues(tab, row)[i]]))),
    );
    this.persist();
  }
  async update(tab, row) {
    await this.updateMany(tab, [row]);
  }
  async updateMany(tab, rows) {
    rows.forEach((row) => {
      this.data[tab][row._row - 2] = Object.fromEntries(
        SCHEMA[tab].map((key) => [key, String(row[key] ?? '')]),
      );
    });
    this.persist();
  }
  async deleteRows(tab, rows) {
    [...rows].sort((a, b) => b - a).forEach((row) => this.data[tab].splice(row - 2, 1));
    this.persist();
  }
  async saveSettings(values) {
    for (const [key, value] of Object.entries(values)) {
      const found = this.data.Settings.find((row) => row.key === key);
      if (found) found.value = String(value);
      else this.data.Settings.push({ key, value: String(value) });
    }
    this.persist();
  }
  async initialize() {
    return [];
  }
}
export function demoGoogle(store) {
  const remote = async (business) =>
    (await store.read('Reviews'))
      .filter((row) => resourceId(row.google_location_id) === resourceId(business.google_location_id))
      .map((row) => ({
        reviewId: row.google_review_id,
        reviewer: { displayName: row.reviewer_name },
        starRating: ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'][Number(row.star_rating)],
        comment: row.comment,
        createTime: row.review_date,
        ...(isTrue(row.is_replied)
          ? { reviewReply: { comment: row.reply_comment, updateTime: row.reply_date } }
          : {}),
      }));
  return {
    async accounts() {
      return [{ name: 'accounts/demo-account', accountName: 'Demo workspace', role: 'MANAGER' }];
    },
    async locations() {
      return [
        ...sampleBusinesses.map(([id, name, address]) => ({
          name: `locations/${id}`,
          title: name,
          storefrontAddress: { addressLines: [address] },
        })),
        {
          name: 'locations/harbor',
          title: 'Harbor Coffee',
          storefrontAddress: { addressLines: ['508 Lake Austin Blvd, Austin, TX'] },
        },
        {
          name: 'locations/greenhouse',
          title: 'The Greenhouse',
          storefrontAddress: { addressLines: ['66 Garden Street, Austin, TX'] },
        },
        {
          name: 'locations/oakwood',
          title: 'Oakwood Dental',
          storefrontAddress: { addressLines: ['92 Oakwood Lane, Austin, TX'] },
        },
      ];
    },
    async reviews(business) {
      return {
        reviews: await remote(business),
        averageRating: Number(business.avg_rating),
        totalReviewCount: Number(business.total_reviews),
      };
    },
    async getReview(business, id) {
      return (await remote(business)).find((review) => review.reviewId === id) || {};
    },
    async postReply(business, id, comment) {
      return { comment, updateTime: new Date().toISOString() };
    },
    async deleteReply() {
      return {};
    },
  };
}
