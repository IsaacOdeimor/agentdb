import { describe, it, expect } from 'vitest';
import { Aggregation } from '../src/aggregation';

const docs = [
  { _id: '1', _ts: 1, name: 'Alice', age: 30, role: 'admin', score: 90 },
  { _id: '2', _ts: 2, name: 'Bob', age: 25, role: 'user', score: 70 },
  { _id: '3', _ts: 3, name: 'Charlie', age: 35, role: 'user', score: 85 },
  { _id: '4', _ts: 4, name: 'Diana', age: 28, role: 'admin', score: 95 },
  { _id: '5', _ts: 5, name: 'Eve', age: 22, role: 'user', score: 60 },
];

describe('Aggregation', () => {
  // ── Scalar Aggregations ─────────────────────────────────

  describe('scalar', () => {
    it('count returns total documents', () => {
      expect(new Aggregation(docs).count()).toBe(5);
    });

    it('count returns 0 for empty', () => {
      expect(new Aggregation([]).count()).toBe(0);
    });

    it('sum computes total', () => {
      expect(new Aggregation(docs).sum('age')).toBe(140); // 30+25+35+28+22
    });

    it('sum ignores non-numeric fields', () => {
      expect(new Aggregation(docs).sum('name')).toBe(0);
    });

    it('avg computes average', () => {
      expect(new Aggregation(docs).avg('age')).toBe(28); // 140/5
    });

    it('avg returns 0 for empty', () => {
      expect(new Aggregation([]).avg('age')).toBe(0);
    });

    it('min returns minimum', () => {
      expect(new Aggregation(docs).min('age')).toBe(22);
    });

    it('max returns maximum', () => {
      expect(new Aggregation(docs).max('age')).toBe(35);
    });

    it('min returns undefined for empty', () => {
      expect(new Aggregation([]).min('age')).toBeUndefined();
    });

    it('distinct returns unique values', () => {
      const roles = new Aggregation(docs).distinct('role');
      expect(roles.sort()).toEqual(['admin', 'user']);
    });

    it('stddev computes standard deviation', () => {
      const sd = new Aggregation(docs).stddev('score');
      expect(sd).toBeGreaterThan(0);
      // scores: 60,70,85,90,95 → mean=80, variance=((20²+10²+5²+10²+15²)/5)=170, sd=√170≈13.038
      expect(sd).toBeCloseTo(13.038, 2);
    });

    it('percentile returns correct value', () => {
      // scores sorted: 60,70,85,90,95
      expect(new Aggregation(docs).percentile('score', 50)).toBe(85); // median
      expect(new Aggregation(docs).percentile('score', 100)).toBe(95);
      expect(new Aggregation(docs).percentile('score', 0)).toBe(60);
    });

    it('percentile returns 0 for empty', () => {
      expect(new Aggregation([]).percentile('score', 50)).toBe(0);
    });
  });

  // ── Pipeline Operations ─────────────────────────────────

  describe('pipeline', () => {
    it('match filters documents', () => {
      const result = new Aggregation(docs).match({ role: 'admin' }).exec();
      expect(result.length).toBe(2);
      expect(result.every(d => d.role === 'admin')).toBe(true);
    });

    it('sort ascending', () => {
      const result = new Aggregation(docs).sort('age', 1).exec();
      expect(result[0].name).toBe('Eve');     // 22
      expect(result[4].name).toBe('Charlie'); // 35
    });

    it('sort descending', () => {
      const result = new Aggregation(docs).sort('age', -1).exec();
      expect(result[0].name).toBe('Charlie'); // 35
      expect(result[4].name).toBe('Eve');     // 22
    });

    it('limit restricts count', () => {
      const result = new Aggregation(docs).limit(3).exec();
      expect(result.length).toBe(3);
    });

    it('skip skips documents', () => {
      const result = new Aggregation(docs).skip(3).exec();
      expect(result.length).toBe(2);
    });

    it('chaining match + sort + limit', () => {
      const result = new Aggregation(docs)
        .match({ role: 'user' })
        .sort('age', 1)
        .limit(2)
        .exec();
      expect(result.length).toBe(2);
      expect(result[0].name).toBe('Eve');   // youngest user (22)
      expect(result[1].name).toBe('Bob');   // next (25)
    });

    it('match + count', () => {
      const count = new Aggregation(docs).match({ role: 'admin' }).count();
      expect(count).toBe(2);
    });

    it('match + sum', () => {
      const sum = new Aggregation(docs).match({ role: 'admin' }).sum('score');
      expect(sum).toBe(185); // 90+95
    });
  });

  // ── Group-by ────────────────────────────────────────────

  describe('group', () => {
    it('groups by field', () => {
      const groups = new Aggregation(docs).group('role');
      expect(groups.length).toBe(2);
      const admin = groups.find(g => g.key === 'admin');
      const user = groups.find(g => g.key === 'user');
      expect(admin!.count).toBe(2);
      expect(user!.count).toBe(3);
    });

    it('groupWith computes metrics', () => {
      const results = new Aggregation(docs).groupWith('role', {
        totalScore: { op: 'sum', field: 'score' },
        avgAge: { op: 'avg', field: 'age' },
        maxScore: { op: 'max', field: 'score' },
      });

      const admin = results.find(r => r.key === 'admin')!;
      expect(admin.totalScore).toBe(185);
      expect(admin.avgAge).toBe(29); // (30+28)/2
      expect(admin.maxScore).toBe(95);

      const user = results.find(r => r.key === 'user')!;
      expect(user.totalScore).toBe(215); // 70+85+60
    });

    it('handles null group key', () => {
      const docsWithNull = [
        ...docs,
        { _id: '6', _ts: 6, name: 'Frank', age: 40, score: 50 }, // no role
      ];
      const groups = new Aggregation(docsWithNull).group('role');
      const nullGroup = groups.find(g => g.key === null);
      expect(nullGroup).toBeDefined();
      expect(nullGroup!.count).toBe(1);
    });
  });

  // ── Histogram ───────────────────────────────────────────

  describe('histogram', () => {
    it('buckets numeric values', () => {
      const hist = new Aggregation(docs).histogram('age', 10);
      // ages: 22,25,28,30,35 → buckets: 20(3), 30(2)
      expect(hist.length).toBe(2);
      expect(hist[0]).toEqual({ bucket: 20, count: 3 });
      expect(hist[1]).toEqual({ bucket: 30, count: 2 });
    });

    it('handles empty input', () => {
      const hist = new Aggregation([]).histogram('age', 10);
      expect(hist.length).toBe(0);
    });
  });

  // ── Dot-notation ────────────────────────────────────────

  describe('dot-notation fields', () => {
    const nestedDocs = [
      { _id: '1', _ts: 1, address: { city: 'NYC', zip: 10001 } },
      { _id: '2', _ts: 2, address: { city: 'LA', zip: 90001 } },
      { _id: '3', _ts: 3, address: { city: 'NYC', zip: 10002 } },
    ];

    it('distinct with nested field', () => {
      const cities = new Aggregation(nestedDocs).distinct('address.city');
      expect(cities.sort()).toEqual(['LA', 'NYC']);
    });

    it('sum with nested field', () => {
      const total = new Aggregation(nestedDocs).sum('address.zip');
      expect(total).toBe(110004);
    });

    it('group by nested field', () => {
      const groups = new Aggregation(nestedDocs).group('address.city');
      const nyc = groups.find(g => g.key === 'NYC');
      expect(nyc!.count).toBe(2);
    });
  });
});
