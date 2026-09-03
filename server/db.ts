import { MongoClient, Db } from 'mongodb';
import {
  SEED_ROLES,
  SEED_DEPARTMENTS,
  SEED_DESIGNATIONS,
  SEED_CYCLES,
  SEED_KRAS,
  SEED_KRA_TEMPLATES,
  SEED_EMPLOYEES,
  SEED_USERS,
  SEED_REVIEW_PERIODS,
  SEED_EMPLOYEE_REVIEWS,
  SEED_APPRAISALS,
  SEED_NOTIFICATIONS,
  SEED_AUDIT_LOGS,
  SEED_FEEDBACK,
  SEED_PIPS,
  SEED_TALENT_RECORDS,
} from './seedData.js';
import {
  User,
  Role,
  Department,
  Designation,
  Cycle,
  Kra,
  Employee,
  KraTemplate,
  ReviewPeriod,
  EmployeeReview,
  Appraisal,
  Notification,
  AuditLog,
  FeedbackEntry,
  PipRecord,
  TalentRecord,
  DbStatus,
} from '../src/types.js';

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let dbMode: 'MONGODB' | 'EMBEDDED_COMPATIBLE' = 'EMBEDDED_COMPATIBLE';
let dbUri: string | undefined = process.env.MONGODB_URI;

// In-memory / document collections store with MongoDB-compatible API
class InMemoryCollection<T extends { id?: string; _id?: any }> {
  private items: Map<string, T> = new Map();
  name: string;

  constructor(name: string, initialData: T[] = []) {
    this.name = name;
    initialData.forEach((item) => {
      const id = item.id || (item as any)._id || `id_${Math.random().toString(36).substr(2, 9)}`;
      this.items.set(String(id), { ...item, id: String(id), _id: String(id) });
    });
  }

  async find(filter: any = {}): Promise<{ toArray: () => Promise<T[]> }> {
    const list = Array.from(this.items.values()).filter((item) => {
      for (const [key, val] of Object.entries(filter)) {
        if (key === '$or' && Array.isArray(val)) {
          const matchOr = val.some((subFilter) =>
            Object.entries(subFilter).every(([subKey, subVal]) => (item as any)[subKey] === subVal)
          );
          if (!matchOr) return false;
          continue;
        }
        if (typeof val === 'object' && val !== null && Array.isArray((val as any).$in)) {
          if (!(val as any).$in.includes((item as any)[key])) return false;
          continue;
        }
        if (typeof val === 'object' && val !== null && '$ne' in (val as any)) {
          if ((item as any)[key] === (val as any).$ne) return false;
          continue;
        }
        if ((item as any)[key] !== val) return false;
      }
      return true;
    });

    return {
      toArray: async () => list,
    };
  }

  async findOne(filter: any = {}): Promise<T | null> {
    const list = (await this.find(filter)).toArray();
    const resolved = await list;
    return resolved.length > 0 ? resolved[0] : null;
  }

  async insertOne(doc: T): Promise<{ insertedId: string; acknowledged: boolean }> {
    const id = doc.id || (doc as any)._id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const saved = { ...doc, id: String(id), _id: String(id) };
    this.items.set(String(id), saved);
    return { insertedId: String(id), acknowledged: true };
  }

  async insertMany(docs: T[]): Promise<{ insertedCount: number; acknowledged: boolean }> {
    for (const doc of docs) {
      await this.insertOne(doc);
    }
    return { insertedCount: docs.length, acknowledged: true };
  }

  async updateOne(filter: any, update: any): Promise<{ matchedCount: number; modifiedCount: number }> {
    const target = await this.findOne(filter);
    if (!target) return { matchedCount: 0, modifiedCount: 0 };

    let updated = { ...target };
    if (update.$set) {
      updated = { ...updated, ...update.$set };
    } else {
      updated = { ...updated, ...update };
    }

    const id = String(target.id || (target as any)._id);
    this.items.set(id, updated);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: any, update: any): Promise<{ matchedCount: number; modifiedCount: number }> {
    const targets = await (await this.find(filter)).toArray();
    let modifiedCount = 0;
    for (const target of targets) {
      let updated = { ...target };
      if (update.$set) {
        updated = { ...updated, ...update.$set };
      } else {
        updated = { ...updated, ...update };
      }
      const id = String(target.id || (target as any)._id);
      this.items.set(id, updated);
      modifiedCount++;
    }
    return { matchedCount: targets.length, modifiedCount };
  }

  async deleteMany(filter: any = {}): Promise<{ deletedCount: number }> {
    const targets = await (await this.find(filter)).toArray();
    let deletedCount = 0;
    for (const target of targets) {
      const id = String(target.id || (target as any)._id);
      this.items.delete(id);
      deletedCount++;
    }
    return { deletedCount };
  }

  async deleteOne(filter: any): Promise<{ deletedCount: number }> {
    const target = await this.findOne(filter);
    if (!target) return { deletedCount: 0 };
    const id = String(target.id || (target as any)._id);
    this.items.delete(id);
    return { deletedCount: 1 };
  }

  async countDocuments(filter: any = {}): Promise<number> {
    const items = await (await this.find(filter)).toArray();
    return items.length;
  }

  async createIndex(_keys: any, _options?: any): Promise<string> {
    return 'index_created';
  }

  getAll(): T[] {
    return Array.from(this.items.values());
  }
}

// In-Memory Collections Table
export const memoryDb = {
  users: new InMemoryCollection<User & { passwordHash: string }>('users', SEED_USERS),
  roles: new InMemoryCollection<Role>('roles', SEED_ROLES),
  departments: new InMemoryCollection<Department>('departments', SEED_DEPARTMENTS),
  designations: new InMemoryCollection<Designation>('designations', SEED_DESIGNATIONS),
  cycles: new InMemoryCollection<Cycle>('cycles', SEED_CYCLES),
  kras: new InMemoryCollection<Kra>('kras', SEED_KRAS),
  kraTemplates: new InMemoryCollection<KraTemplate>('kra_templates', SEED_KRA_TEMPLATES),
  employees: new InMemoryCollection<Employee>('employees', SEED_EMPLOYEES),
  reviewPeriods: new InMemoryCollection<ReviewPeriod>('review_periods', SEED_REVIEW_PERIODS),
  employeeReviews: new InMemoryCollection<EmployeeReview>('employee_reviews', SEED_EMPLOYEE_REVIEWS),
  appraisals: new InMemoryCollection<Appraisal>('appraisals', SEED_APPRAISALS),
  notifications: new InMemoryCollection<Notification>('notifications', SEED_NOTIFICATIONS),
  auditLogs: new InMemoryCollection<AuditLog>('audit_logs', SEED_AUDIT_LOGS),
  feedback: new InMemoryCollection<FeedbackEntry>('feedback', SEED_FEEDBACK),
  pips: new InMemoryCollection<PipRecord>('pips', SEED_PIPS),
  talentRecords: new InMemoryCollection<TalentRecord>('talent_records', SEED_TALENT_RECORDS),
};

export async function initDatabase(): Promise<void> {
  const uri = process.env.MONGODB_URI;

  if (uri && !uri.includes('localhost:27017')) {
    try {
      console.log(`[Database] Attempting connection to MongoDB at: ${uri.replace(/\/\/.*@/, '//***@')}`);
      mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 2500 });
      await mongoClient.connect();
      mongoDb = mongoClient.db('quarterly_appraisal_db');
      dbMode = 'MONGODB';
      console.log('[Database] Connected to external MongoDB successfully');
      await seedMongoCollectionsIfEmpty(mongoDb);
      return;
    } catch (err: any) {
      console.warn(`[Database] MongoDB URI provided but connection timed out/failed (${err.message}). Using Embedded Document Mode for continuous availability.`);
      dbMode = 'EMBEDDED_COMPATIBLE';
    }
  } else {
    console.log('[Database] Initialized in High-Performance Embedded Document Mode with MongoDB Compass Schemas.');
    dbMode = 'EMBEDDED_COMPATIBLE';
  }
}

const MONGO_COLLECTION_MAP: Record<string, string> = {
  reviewPeriods: 'review_periods',
  employeeReviews: 'employee_reviews',
  kraTemplates: 'kra_templates',
  auditLogs: 'audit_logs',
  talentRecords: 'talent_records',
};

export function getDbCollection<T extends { id?: string; _id?: any }>(collectionName: keyof typeof memoryDb): any {
  if (dbMode === 'MONGODB' && mongoDb) {
    const mapped = MONGO_COLLECTION_MAP[collectionName] || collectionName;
    return mongoDb.collection(mapped);
  }
  return memoryDb[collectionName];
}

async function seedMongoCollectionsIfEmpty(db: Db): Promise<void> {
  console.log('[Database] Checking and syncing MongoDB collections with latest seed schema...');
  
  const upsertCollection = async (collectionKey: keyof typeof memoryDb, seedData: any[]) => {
    const col = getDbCollection(collectionKey);
    for (const doc of seedData) {
      if (doc && doc.id) {
        await col.updateOne({ id: doc.id }, { $set: doc }, { upsert: true });
      }
    }
  };

  await upsertCollection('users', SEED_USERS);
  try {
    const usersCol = getDbCollection('users');
    await usersCol.deleteOne({ id: 'usr_hr_persona' });
    await usersCol.deleteOne({ email: 'hr.admin@company.com' });
    await usersCol.deleteMany({ role: 'HR', id: { $ne: 'usr_mgr_hr' } });
    await usersCol.deleteOne({ id: 'usr_mgr_ta' });
    await usersCol.deleteOne({ email: 'leo.hiring@company.com' });
  } catch (_e) {
    // Ignore if not present
  }
  await upsertCollection('roles', SEED_ROLES);
  await upsertCollection('departments', SEED_DEPARTMENTS);
  await upsertCollection('designations', SEED_DESIGNATIONS);
  try {
    const desCol = getDbCollection('designations');
    await desCol.deleteOne({ id: 'des_hr_ta' });
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('cycles', SEED_CYCLES);
  await upsertCollection('kras', SEED_KRAS);
  await upsertCollection('kraTemplates', SEED_KRA_TEMPLATES);
  await upsertCollection('employees', SEED_EMPLOYEES);
  try {
    const empCol = getDbCollection('employees');
    await empCol.deleteOne({ id: 'emp_mgr_ta' });
    await empCol.deleteOne({ email: 'leo.hiring@company.com' });
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('reviewPeriods', SEED_REVIEW_PERIODS);
  await upsertCollection('employeeReviews', SEED_EMPLOYEE_REVIEWS);
  try {
    const revCol = getDbCollection('employeeReviews');
    await revCol.deleteMany({ employeeId: 'emp_mgr_ta' });
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('appraisals', SEED_APPRAISALS);
  try {
    const appCol = getDbCollection('appraisals');
    await appCol.deleteMany({ employeeId: 'emp_mgr_ta' });
    await appCol.deleteOne({ id: 'app_2026_leo' });
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('notifications', SEED_NOTIFICATIONS);
  try {
    const notifsCol = getDbCollection('notifications');
    await notifsCol.deleteMany({ userId: 'usr_mgr_ta' });
    await notifsCol.deleteOne({ id: 'notif_mgr_ta_1' });
    await notifsCol.updateOne(
      { id: 'notif_mgr_eng_1' },
      { $set: { metadata: { periodId: 'period_2026_q1', status: 'MANAGER_PENDING' } } }
    );
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('auditLogs', SEED_AUDIT_LOGS);
  await upsertCollection('feedback', SEED_FEEDBACK);
  try {
    const fbCol = getDbCollection('feedback');
    await fbCol.deleteMany({ toEmployeeId: 'emp_mgr_ta' });
    await fbCol.deleteOne({ id: 'fb_5' });
  } catch (_e) {
    // Ignore
  }
  await upsertCollection('pips', SEED_PIPS);
  await upsertCollection('talentRecords', SEED_TALENT_RECORDS);
  try {
    const talCol = getDbCollection('talentRecords');
    await talCol.deleteMany({ employeeId: 'emp_mgr_ta' });
    await talCol.deleteOne({ id: 'tal_leo' });
  } catch (_e) {
    // Ignore
  }

  try {
    await getDbCollection('employeeReviews').createIndex({ employeeId: 1, reviewPeriodId: 1 }, { unique: true });
    await getDbCollection('employees').createIndex({ employeeCode: 1 }, { unique: true });
    await getDbCollection('users').createIndex({ email: 1 }, { unique: true });
  } catch (err) {
    // Indexes might already exist
  }
  console.log('[Database] MongoDB collections ready and fully synced.');
}

export async function getDatabaseStatus(): Promise<DbStatus> {
  const counts = {
    users: await getDbCollection('users').countDocuments(),
    employees: await getDbCollection('employees').countDocuments(),
    departments: await getDbCollection('departments').countDocuments(),
    designations: await getDbCollection('designations').countDocuments(),
    cycles: await getDbCollection('cycles').countDocuments(),
    kras: await getDbCollection('kras').countDocuments(),
    kraTemplates: await getDbCollection('kraTemplates').countDocuments(),
    reviewPeriods: await getDbCollection('reviewPeriods').countDocuments(),
    employeeReviews: await getDbCollection('employeeReviews').countDocuments(),
    appraisals: await getDbCollection('appraisals').countDocuments(),
    notifications: await getDbCollection('notifications').countDocuments(),
    auditLogs: await getDbCollection('auditLogs').countDocuments(),
  };

  return {
    connected: true,
    mode: dbMode,
    uri: dbUri,
    databaseName: 'quarterly_appraisal_db',
    collections: counts,
  };
}
