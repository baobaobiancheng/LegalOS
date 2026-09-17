一、CAS系统后台配置
1. SRE配置域名和IP
需要SRE团队配置以下域名和IP[3]：
预发环境: 10.100.123.74 cas-pre.100credit.cn
生产环境: 192.168.162.111 cas.100credit.cn
2. 新建项目并配置项目信息
在CAS后台管理系统中创建新项目，需配置以下关键信息[1,2]：
项目名称: 对外展示的名称
项目简称(code): 项目方与CAS对接用的编码
应用图标: 项目Logo
项目认证登录URL: 业务系统的登录地址（如 http://bms-pre.100credit.cn/login）
是否默认开通: 是否对所有用户默认开放
是否可以申请: 是否允许用户自主申请
是否对接权限系统: 是否接入公司统一权限系统
权限配置: 功能权限、数据权限、字段权限、组织架构权限等
￼
￼
3. 配置CAS后台管理权限
联系CAS系统负责人（郭广旭）为项目研发人员开通后台管理权限[1]。
￼
4. 进入CAS后台权限-配置角色
在CAS后台的"授权管理-角色列表"中为项目创建角色，如管理员、正式、测试等[1]。
￼
￼
二、后台系统对接CAS登录
1. 项目认证登录URL配置
在CAS后台配置项目的认证登录URL，该URL是前端编写登录页面的依据[1]。
￼
2. 前端开发
前端根据项目认证登录URL编写登录页面，对接后端登录和登出接口[1]。
当用户从CAS登录页跳转回业务系统时，CAS会自动传递ticket参数，例如：
￼
其中ticket的值由CAS系统自动传递[1]。
3. 后端开发登录接口
使用cas-spring-boot-starter（推荐方式）
添加依赖:
￼
配置参数(application.yml):
￼
Ticket校验实现:
￼
CasAuthResult包含的用户信息:
username: 用户登录名
name: 用户真实姓名
email: 用户邮箱
role: 用户在本项目的角色名称
roleCode: 用户在本项目的角色Code
deptId/deptName: 用户所属部门
projectCode: 项目Code[3]
查询用户完整权限:
￼
相关Git地址和文档: http://git.100credit.cn/br-tc/bootkit/cas-spring-boot-starter[1,3]。
￼
三、单点登录流程
CAS系统与对接系统的单点登录流程如下[4]：
￼
用户点击目标系统
CAS系统生成ticket并传递给业务系统前端
业务系统前端将ticket传给后端
后端调用CAS的validate接口验证ticket
验证通过，返回用户数据，正常登录
验证失败，返回CAS登录页重新登录
￼
四、用户申请应用入口
用户可以在CAS前台申请应用权限，审批通过后即可访问[1]。
￼
￼
五、MQ消息对接（可选）
如果需要在OA审批通过后自动执行业务逻辑，可以订阅CAS发送的MQ消息[5]：
Exchange: casProjectApplyExchange
RoutingKey: casProjectApplyKey.#
消息包含projectCode、projectName、roleCode、username、realname等信息[5]。
￼
六、注意事项
Ticket是一次性的，有效期5分钟，验证后即失效[6]
建议使用Redis集中管理Session，支持分布式部署[6]
所有传输应使用HTTPS，确保安全性[6]
海外CAS对接与国内基本一致，但域名和host不同，联系人：雷文、薛振、刘芳[7]
请对此次回复做出评价，￼或￼
引用文档：
11、cas系统--应用入口前后端对接文档：
对接权限系统后台配置
cas-starter对接说明文档
对接流程图
8、cas应用申请--mq消息配置--消费者消费消息
02-CAS单点登录知识点
3、海外CAS对接