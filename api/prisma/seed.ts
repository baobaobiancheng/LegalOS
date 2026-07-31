import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * 种子用户（设计文档「种子用户」表）
 * v0.0.1 密码从环境变量注入，生产部署前需改为强密码 + 首次登录强制改密
 */
const seedUsers = [
  {
    username: 'admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'admin123',
    role: Role.admin,
    displayName: '系统管理员',
  },
  {
    username: 'legal_bp',
    password: process.env.SEED_LEGAL_BP_PASSWORD || 'legal123',
    role: Role.legal_bp,
    displayName: '法务BP-张三',
  },
  {
    username: 'legal_lead',
    password: process.env.SEED_LEGAL_LEAD_PASSWORD || 'legal123',
    role: Role.legal_lead,
    displayName: '法务负责人-李四',
  },
  {
    username: 'business',
    password: process.env.SEED_BUSINESS_PASSWORD || 'biz123',
    role: Role.business,
    displayName: '业务-王五',
  },
];

async function main() {
  for (const item of seedUsers) {
    const passwordHash = await bcrypt.hash(item.password, 10);
    await prisma.user.upsert({
      where: { username: item.username },
      update: { passwordHash, role: item.role, displayName: item.displayName },
      create: {
        username: item.username,
        passwordHash,
        role: item.role,
        displayName: item.displayName,
      },
    });
    console.log(`seeded: ${item.username} (${item.role})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
