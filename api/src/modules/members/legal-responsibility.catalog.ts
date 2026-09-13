/** 部分职责清单。部门 ID/名称来自 2026-09-13 钉钉只读核验；未核实范围不自动启用。 */
export interface LegalResponsibility {
  key: string;
  name: string;
  casUsername: string | null;
  businessLines: string[];
  description: string;
  scopes: { id: string; name: string }[];
  pendingScopes: string[];
}

const commonSupport = '项目业务模式与合作方案合规评估、合同起草与审核、营销及用户授权材料审核、个人信息保护、项目法律咨询及风险提示、相关文件出具。';

export const LEGAL_RESPONSIBILITIES: readonly LegalResponsibility[] = [
  {
    key: 'peng-yuxin', name: '彭宇欣', casUsername: 'yuxin.peng', businessLines: ['MaaS业务线', 'AaaS业务线'],
    description: `负责华东 RU 相关项目及 MaaS、AaaS 业务线法律合规支持：${commonSupport}`,
    scopes: [{ id: '1054284003', name: '华东RU' }, { id: '997578737', name: '智能交互技术开发部' }],
    pendingScopes: ['AaaS BG—企业EX产品开发部／企业硅基员工服务：需确认具体人员范围，暂不扩大为整个企业 EX 部门'],
  },
  {
    key: 'chen-dong', name: '陈东', casUsername: 'dong.chen',
    businessLines: ['MaaS业务线（数据产品部）', 'AaaS业务线', '华西南RU', '生态合作部（数据源）'],
    description: `负责华西南 RU 相关项目及 MaaS 数据产品部法律合规支持：${commonSupport}`,
    scopes: [{ id: '1054097030', name: '华西南RU' }],
    pendingScopes: ['MaaS 数据产品部：尚未确认现组织树对应部门 ID，不按整个 MaaS BG 分配'],
  },
  {
    key: 'li-xiaoxiao', name: '李潇潇', casUsername: 'xiaoxiao.li', businessLines: ['BaaS业务线', '生态合作部'],
    description: '负责 BaaS 业务线、生态合作部的法律合规支持：业务模式与合作方案评估、合作方准入审核、合同起草与审核、数据安全评估、营销及用户授权材料审核、个人信息保护、项目咨询及风险提示、相关文件出具。该范围直接分配李潇潇。',
    scopes: [{ id: '709180775', name: 'BaaS BG' }, { id: '918051239', name: '生态合作部' }], pendingScopes: [],
  },
  {
    key: 'diao-yingnan', name: '刁英楠', casUsername: 'yingnan.diao', businessLines: ['AaaS业务线—智能特资业务线'],
    description: '负责智能特资业务线的资产包评估、劣后投资人准入、资产包合作处置机构准入、交易文件草拟及审核、投后文件支持；百灵、百回产品法律合规支持。',
    scopes: [{ id: '927101673', name: '智能特资业务线' }], pendingScopes: [],
  },
  {
    key: 'sun-wenhong', name: '孙文弘', casUsername: 'wenhong.sun', businessLines: ['MaaS海外业务线', 'AaaS海外业务线'],
    description: '负责海外法律合规支持：业务模式与合作方案评估、合作方准入审核、合同起草与审核、数据安全评估、营销及用户授权材料审核、个人信息保护、项目法律咨询及风险提示、相关文件出具。',
    scopes: [], pendingScopes: ['MaaS 海外相关同事', 'AaaS 海外相关同事（均需确认部门 ID 或独立人员范围）'],
  },
  {
    key: 'wang-yu', name: '王玉', casUsername: null, businessLines: ['MaaS业务线', 'AaaS业务线'],
    description: `负责华北 RU 相关项目及 MaaS、AaaS 业务线法律合规支持：${commonSupport}`,
    scopes: [
      { id: '1054304001', name: '华北RU' }, { id: '997847345', name: 'AICC业务线' },
      { id: '997499757', name: '百智百销业务线' }, { id: '1001444875', name: 'AI_Infra产品组' },
      { id: '1091927956', name: '智能中小微业务线' },
    ], pendingScopes: [],
  },
];
