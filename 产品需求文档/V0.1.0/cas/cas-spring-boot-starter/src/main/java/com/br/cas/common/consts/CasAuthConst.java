package com.br.cas.common.consts;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
public class CasAuthConst {

    /**
     * ticket认证登陆接口
     */
    public static final String VALIDATE_TICKET_URL = "/validate";

    /**
     * 获取用户对应项目权限
     */
    public static final String USER_PROJECT_PERMISSION_URL = "/api/module/queryUserInfoAndModulesOfProject";

    /**
     * 判断用户是否已开通权限
     */
    public static final String CHECK_USER_AUTHORITY_URL = "/api/personalAuthority/isExistByUsername";

    /**
     * 根据角色code获取用户信息
     */
    public static final String ROLE_USER_INFO_URL = "/api/project/role/user/list";

    /**
     * 新增CAS项目入口和CAS项目角色权限
     */
    public static final String ADD_USER_PROJECT_URL = "/api/personalAuthority/addUserProject";

    /**
     * 获取角色的数据权限和菜单权限列表
     */
    public static final String ROLE_MODULE_AND_DATA_PERMISSION = "/api/personalAuthority/roleModuleAndDataPermission";

    /**
     * 获取用户角色列表
     */
    public static final String USER_ROLE_LIST = "/api/personalAuthority/getUserRoleList";


    /**
     * 校验用户名和密码是否正确
     */
    public static final String VALIDATE_USER = "/api/user/validate";

}
