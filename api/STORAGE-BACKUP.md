# storage/ 目录说明与备份策略

> 本目录**已被 .gitignore 忽略**（合同文件等敏感数据绝不进入 git 仓库）

## 目录结构

```
storage/
├── contracts/{projectId}/     # 合同协作上传的附件（修订版/定稿），文件名 uuid+扩展名
└── contract-templates/{slug}/ # 合同模板源文件（百融AI服务协议/保密协议V4.5/技术开发合同）
```

## 备份策略（MVP）

- **每周全量**：压缩归档整个 `storage/` 目录
- **每日增量**：同步新增/变更文件
- **保留**：最近 4 周全量归档

### 全量备份命令（Windows）

```powershell
# 每周执行一次，归档命名带日期
Compress-Archive -Path storage -DestinationPath "D:\backups\legal-platform-storage-$(Get-Date -Format 'yyyyMMdd').zip"
```

### 恢复步骤

1. 停 API 服务
2. 解压归档覆盖 `api/storage/`
3. 启动 API（ContractFile 表存的是相对路径 `{projectId}/{uuid}.ext`，目录结构一致即可恢复）

## OSS 迁移预留（v0.1.0）

- 文件读写集中在 `ContractService`（uploadFile/downloadFile），迁移 OSS 时替换这两个方法的实现
- `ContractFile.storedName` 当前是磁盘文件名；迁移后改为 OSS object key，DB 表结构不变
