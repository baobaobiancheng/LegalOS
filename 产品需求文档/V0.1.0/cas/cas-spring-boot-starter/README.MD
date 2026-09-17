# cas-spring-boot-starter

对接 CAS 统一认证系统的 Spring Boot Starter，封装了 Ticket 校验、用户权限查询、角色管理等常用接口，开箱即用。

---

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
  - [1. 添加依赖](#1-添加依赖)
  - [2. 配置参数](#2-配置参数)
  - [3. 注入并使用](#3-注入并使用)
- [典型接入场景](#典型接入场景)
  - [CAS 单点登录（Ticket 校验）](#cas-单点登录ticket-校验)
  - [查询用户在本项目的完整权限](#查询用户在本项目的完整权限)
  - [校验用户是否拥有某角色](#校验用户是否拥有某角色)
  - [根据角色查询用户列表](#根据角色查询用户列表)
  - [为用户开通项目及角色权限](#为用户开通项目及角色权限)
  - [查询角色的菜单与数据权限](#查询角色的菜单与数据权限)
  - [查询用户的角色列表](#查询用户的角色列表)
  - [校验用户名和密码](#校验用户名和密码)
- [API 参考](#api-参考)
- [返回值说明](#返回值说明)
  - [CasAuthResult](#casauthresult)
  - [CasResult\<T\>](#casresultt)
  - [CasUserProjectPermission](#casUserProjectPermission)
  - [RoleModuleAndDataPermissionVo](#rolemoduleanddatapermissionvo)
- [高级配置](#高级配置)
  - [自定义超时时间](#自定义超时时间)
  - [手动注册 Bean（覆盖自动装配）](#手动注册-bean覆盖自动装配)
- [常见问题](#常见问题)

---

## 环境要求

| 依赖 | 版本要求 |
|------|---------|
| Java | 8+ |
| Spring Boot | 2.7.x |
| fastjson | 2.x（见下方说明） |

---

## 快速开始

### 1. 添加依赖

在 `pom.xml` 中添加：

```xml
<dependency>
    <groupId>com.br</groupId>
    <artifactId>cas-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

> **注意**：本 Starter 将 `fastjson` 标记为 `provided`，若业务项目中未显式依赖，需手动添加：
> ```xml
> <dependency>
>     <groupId>com.alibaba</groupId>
>     <artifactId>fastjson</artifactId>
>     <version>2.0.9</version>
> </dependency>
> ```

---

### 2. 配置参数

在 `application.yml`（或 `application.properties`）中添加以下配置：

```yaml
br-cas:
  host: http://cas.example.com      # CAS 服务地址，末尾不需要加斜杠
  projectCode: your-project-code    # 在 CAS 中注册的项目 Code
```

> **说明**：`host` 和 `projectCode` **两项均为必填**。缺少任意一项，`CasAuthService` Bean 将不会被自动注册，注入时会报错。

---

### 3. 注入并使用

配置完成后，直接在 Spring 组件中注入即可：

```java
@Service
public class LoginService {

    @Autowired
    private CasAuthService casAuthService;

    // 使用 casAuthService 调用各接口...
}
```

---

## 典型接入场景

### CAS 单点登录（Ticket 校验）

**场景**：用户从 CAS 登录页跳转回业务系统时，携带 `ticket` 参数。业务系统需用此 ticket 换取用户信息，完成登录。

```java
@GetMapping("/login/callback")
public String casCallback(@RequestParam String ticket, HttpSession session) {
    CasAuthResult result = casAuthService.validateTicket(ticket);

    if (result.fail()) {
        // ticket 无效或已过期，重定向到 CAS 登录页
        return "redirect:/cas/login";
    }

    // 认证成功，将用户信息存入 Session
    session.setAttribute("currentUser", result.getUsername());
    session.setAttribute("userRole", result.getRoleCode());
    return "redirect:/home";
}
```

**`CasAuthResult` 中包含的用户信息：**

| 字段 | 含义 |
|------|------|
| `username` | 用户登录名 |
| `name` | 用户真实姓名 |
| `email` | 用户邮箱 |
| `role` | 用户在本项目的角色名称 |
| `roleCode` | 用户在本项目的角色 Code |
| `deptId` / `deptName` | 用户所属部门 |
| `zone` / `zoneId` | 用户所属区域 |
| `projectCode` | 项目 Code |

---

### 查询用户在本项目的完整权限

**场景**：用户登录后，前端需要根据权限动态渲染菜单、控制按钮显示，后端需要加载用户的数据权限。

```java
CasResult<CasUserProjectPermission> result = casAuthService.userProjectPermission(username);

if (result.fail()) {
    throw new RuntimeException("权限查询失败：" + result.getMessage());
}

CasUserProjectPermission permission = result.getResult();

// 获取菜单列表（JSON 字符串）
String menuList = permission.getMenuList();

// 获取数据权限列表
List<CasDataCategory> dataPermissions = permission.getDataPermissionList();

// 获取字段权限（key 为模块 code）
Map<String, List<CasModuleField>> fieldPermissions = permission.getFieldPermissionMap();

// 获取接口权限列表
List<CasModuleUrl> moduleUrls = permission.getModuleUrlList();

// 判断是否拥有测试数据权限
boolean hasTestData = Integer.valueOf(1).equals(permission.getTestDataPermission());
```

---

### 校验用户是否拥有某角色

**场景**：快速判断某用户是否具有特定角色权限（如管理员角色），用于接口级鉴权。

```java
// 返回原始字符串，需自行判断
String checkResult = casAuthService.userPermissionExist(username, "管理员");

// CAS 返回 "true" 表示有权限，"false" 表示无权限（请以实际 CAS 返回为准）
if ("true".equals(checkResult)) {
    // 用户拥有该角色
}
```

> **注意**：`roleName` 参数为角色的**中文名称**，非角色 Code。

---

### 根据角色查询用户列表

**场景**：查询拥有某个角色的所有用户，常用于消息推送、审批流指定处理人等场景。

```java
CasResult<List<CasRoleUser>> result = casAuthService.userListByRole("ROLE_ADMIN");

if (result.ok()) {
    List<CasRoleUser> users = result.getResult();
    for (CasRoleUser user : users) {
        System.out.println(user.getUsername() + " - " + user.getRealName());
    }
}
```

**`CasRoleUser` 字段：**

| 字段 | 含义 |
|------|------|
| `username` | 用户登录名 |
| `realName` | 用户真实姓名 |
| `email` | 用户邮箱 |
| `state` | 账号状态 |

---

### 为用户开通项目及角色权限

**场景**：用户注册或被管理员邀请后，需要自动为其在 CAS 中开通项目访问入口和对应角色权限。

> **前置条件**：需要在 CAS 系统中为本项目配置**外部接口 Token**，调用此接口时须传入该 Token。

```java
String token = "your-cas-external-token"; // CAS 系统配置的外部接口 Token

String addResult = casAuthService.addUserProjectAndRole(username, "普通用户", token);

// 返回值为原始字符串，请根据实际 CAS 返回内容判断是否成功
System.out.println("开通结果：" + addResult);
```

---

### 查询角色的菜单与数据权限

**场景**：初始化或刷新角色权限缓存时，批量获取某角色拥有的所有菜单和数据权限。

```java
String token = "your-cas-external-token";

CasResult<RoleModuleAndDataPermissionVo> result =
        casAuthService.getRoleModuleAndDataPermission("ROLE_ADMIN", token);

if (result.ok()) {
    RoleModuleAndDataPermissionVo vo = result.getResult();
    
    // 菜单权限列表
    List<ModuleCache> menuList = vo.getMenuList();
    
    // 数据权限分类列表
    List<DataCategoryVo> dataPermissions = vo.getDataPermissionList();
    
    System.out.println("角色名称：" + vo.getRoleName());
}
```

---

### 查询用户的角色列表

**场景**：展示用户当前拥有的所有角色，或用于权限变更后的确认。

```java
String token = "your-cas-external-token";

CasResult<List<RoleVo>> result = casAuthService.getUserRoleList(username, token);

if (result.ok()) {
    List<RoleVo> roles = result.getResult();
    roles.forEach(role -> System.out.println(role.getRoleCode() + " - " + role.getRoleName()));
}
```

---

### 校验用户名和密码

**场景**：业务系统需要对用户进行本地密码二次验证（如操作敏感功能前的身份确认）。

```java
CasResult<String> result = casAuthService.validateUser(username, password);

if (result.ok()) {
    // 用户名和密码正确
} else {
    // 验证失败，result.getMessage() 包含错误原因
    System.out.println("验证失败：" + result.getMessage());
}
```

---

## API 参考

| 方法签名 | 说明 | 是否需要 token |
|---------|------|:---:|
| `validateTicket(ticket)` | Ticket 认证，返回用户信息 | 否 |
| `validateTicket(ticket, timeout)` | 同上，自定义超时（毫秒） | 否 |
| `userProjectPermission(userName)` | 查询用户在本项目的完整权限 | 否 |
| `userProjectPermission(userName, timeout)` | 同上，自定义超时 | 否 |
| `userPermissionExist(userName, roleName)` | 校验用户是否拥有某角色（中文名） | 否 |
| `userPermissionExist(userName, roleName, timeout)` | 同上，自定义超时 | 否 |
| `userListByRole(roleCode)` | 根据角色 Code 查询用户列表 | 否 |
| `userListByRole(roleCode, timeout)` | 同上，自定义超时 | 否 |
| `addUserProjectAndRole(userName, roleName, token)` | 为用户开通项目和角色权限 | **是** |
| `addUserProjectAndRole(userName, roleName, token, timeout)` | 同上，自定义超时 | **是** |
| `getRoleModuleAndDataPermission(roleCode, token)` | 查询角色的菜单和数据权限 | **是** |
| `getRoleModuleAndDataPermission(roleCode, token, timeout)` | 同上，自定义超时 | **是** |
| `getUserRoleList(userName, token)` | 查询用户的角色列表 | **是** |
| `getUserRoleList(userName, token, timeout)` | 同上，自定义超时 | **是** |
| `validateUser(username, password)` | 校验用户名和密码 | 否 |

> **`token` 说明**：部分接口需要传入 `token`，该值为 CAS 系统针对本项目配置的**外部接口调用凭证**，与用户登录 ticket 无关。请联系 CAS 管理员获取。

---

## 返回值说明

### CasAuthResult

`validateTicket` 的返回类型，`ok()` 方法判断 `status == "success"`。

```java
CasAuthResult result = casAuthService.validateTicket(ticket);
result.ok();         // true 表示认证成功
result.fail();       // true 表示认证失败
result.getStatus();  // "success" 或其他错误状态
result.getMsg();     // 错误描述信息
result.getUsername(); // 用户登录名
result.getName();     // 用户真实姓名
result.getEmail();    // 邮箱
result.getRoleCode(); // 在本项目的角色 Code
result.getDeptName(); // 所属部门名称
```

### CasResult\<T\>

其他接口的通用返回包装，`ok()` 方法判断 `code == 0`。

```java
CasResult<T> result = casAuthService.someMethod(...);
result.ok();          // true 表示请求成功
result.fail();        // true 表示请求失败
result.getCode();     // 状态码，0 表示成功
result.getMessage();  // 描述信息
result.getResult();   // 实际数据（泛型 T）
```

### CasUserProjectPermission

`userProjectPermission` 返回的数据结构，包含用户在本项目的全部权限信息。

| 字段 | 类型 | 说明 |
|------|------|------|
| `userInfo` | `CasUserInfo` | 用户基本信息及角色列表 |
| `menuList` | `String` | 菜单列表（JSON 字符串） |
| `testDataPermission` | `Integer` | 测试数据权限，`1` 表示有，其他表示无 |
| `dataPermissionList` | `List<CasDataCategory>` | 数据权限分类列表 |
| `orgPermissionMap` | `Map<String, List<CasOrgTreeNode>>` | 组织权限，key 为角色 Code |
| `personPermissionMap` | `Map<String, CasOrgPersonPermission>` | 人员权限，key 为角色 Code |
| `fieldPermissionMap` | `Map<String, List<CasModuleField>>` | 字段权限，key 为模块 Code |
| `moduleUrlList` | `List<CasModuleUrl>` | 接口访问权限列表 |

### RoleModuleAndDataPermissionVo

`getRoleModuleAndDataPermission` 返回的数据结构。

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectCode` | `String` | 项目 Code |
| `roleId` | `Integer` | 角色 ID |
| `roleCode` | `String` | 角色 Code |
| `roleName` | `String` | 角色名称 |
| `menuList` | `List<ModuleCache>` | 菜单权限列表 |
| `dataPermissionList` | `List<DataCategoryVo>` | 数据权限分类列表 |

---

## 高级配置

### 自定义超时时间

所有主要方法均提供带 `timeout` 参数的重载版本，单位为**毫秒**。不传 timeout 时，使用 Hutool 的全局默认超时。

```java
// 设置 5 秒超时
CasAuthResult result = casAuthService.validateTicket(ticket, 5000);

CasResult<CasUserProjectPermission> permResult =
        casAuthService.userProjectPermission(username, 5000);
```

### 手动注册 Bean（覆盖自动装配）

如需自定义 `host` 或 `projectCode`（例如读取自数据库、加密配置等），可手动注册 `CasAuthService` Bean，会覆盖自动装配：

```java
@Configuration
public class MyCasConfig {

    @Bean
    public CasAuthService casAuthService() {
        String host = "http://cas.example.com";
        String projectCode = "my-project";
        return new CasAuthService(host, projectCode);
    }
}
```

> 手动注册后，`application.yml` 中的 `br-cas.*` 配置不再生效。

---

## 常见问题

**Q：配置了 `br-cas.host` 和 `br-cas.projectCode`，注入 `CasAuthService` 时报 `NoSuchBeanDefinitionException`？**

A：请检查配置项名称是否正确（注意 `projectCode` 大小写），以及配置文件是否被正确加载（检查 Spring 激活的 profile）。

---

**Q：`validateTicket` 返回 `fail()`，是什么原因？**

A：常见原因：① ticket 已被使用（CAS ticket 一次性有效）；② ticket 已过期；③ `host` 地址配置错误导致请求失败后返回了非预期内容。可打印 `result.getMsg()` 查看详细原因。

---

**Q：需要 `token` 的接口，token 从哪里获取？**

A：该 token 是 CAS 系统为每个接入项目单独配置的外部接口调用凭证，与用户登录无关。请联系 CAS 系统管理员为本项目申请并获取。

---

**Q：如何在多环境中使用不同的 CAS 地址？**

A：利用 Spring Boot 的 Profile 机制即可：

```yaml
# application-dev.yml
br-cas:
  host: http://cas-dev.example.com
  projectCode: my-project

# application-prod.yml
br-cas:
  host: http://cas.example.com
  projectCode: my-project
```
