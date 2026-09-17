package com.br.cas.service;

import cn.hutool.http.HttpGlobalConfig;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.br.cas.bean.auth.CasRoleUser;
import com.br.cas.bean.auth.CasUserProjectPermission;
import com.br.cas.bean.auth.RoleModuleAndDataPermissionVo;
import com.br.cas.bean.auth.RoleVo;
import com.br.cas.bean.result.CasAuthResult;
import com.br.cas.bean.result.CasResult;
import com.br.cas.common.consts.CasAuthConst;

import java.util.HashMap;
import java.util.List;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
public class CasAuthService {

    private String host;
    private String projectCode;

    public CasAuthService(String host, String projectCode) {
        this.host = host;
        this.projectCode = projectCode;
    }

    private CasAuthResult getValidateTicket(String ticket, int timeout) {
        String url = this.host + CasAuthConst.VALIDATE_TICKET_URL;
        HashMap<String, Object> params = new HashMap<>();
        params.put("ticket", ticket);
        String r = HttpUtil.get(url, params, timeout);
        return JSONObject.parseObject(r, CasAuthResult.class);
    }

    public CasAuthResult validateTicket(String ticket, int timeout) {
        return this.getValidateTicket(ticket, timeout);
    }

    public CasAuthResult validateTicket(String ticket) {
        return this.getValidateTicket(ticket, HttpGlobalConfig.getTimeout());
    }

    private CasResult<CasUserProjectPermission> getUserProjectPermission(String userName, int timeout) {
        String url = this.host + CasAuthConst.USER_PROJECT_PERMISSION_URL;
        HashMap<String, Object> params = new HashMap<>();
        params.put("userName", userName);
        params.put("projectCode", this.projectCode);
        String r = HttpUtil.get(url, params, timeout);
        return JSONObject.parseObject(r, new TypeReference<CasResult<CasUserProjectPermission>>(CasUserProjectPermission.class) {
        });
    }

    public CasResult<CasUserProjectPermission> userProjectPermission(String userName, int timeout) {
        return this.getUserProjectPermission(userName, timeout);
    }

    public CasResult<CasUserProjectPermission> userProjectPermission(String userName) {
        return this.getUserProjectPermission(userName, HttpGlobalConfig.getTimeout());
    }

    private String getUserPermissionExist(String userName, String roleName, int timeout) {
        String url = this.host + CasAuthConst.CHECK_USER_AUTHORITY_URL;
        HashMap<String, Object> params = new HashMap<>();
        params.put("projectCode", this.projectCode);
        params.put("userName", userName);
        params.put("roleName", roleName);
        return HttpUtil.get(url, params, timeout);
    }

    public String userPermissionExist(String userName, String roleName) {
        return this.getUserPermissionExist(userName, roleName, HttpGlobalConfig.getTimeout());
    }

    public String userPermissionExist(String userName, String roleName, int timeout) {
        return this.getUserPermissionExist(userName, roleName, timeout);
    }

    private CasResult<List<CasRoleUser>> getUserListByRole(String roleCode, int timeout) {
        String url = this.host + CasAuthConst.ROLE_USER_INFO_URL;
        HashMap<String, Object> params = new HashMap<>();
        params.put("projectCode", this.projectCode);
        params.put("roleCode", roleCode);
        String r = HttpUtil.get(url, params, timeout);
        return JSONObject.parseObject(r, new TypeReference<CasResult<List<CasRoleUser>>>(CasRoleUser.class) {
        });
    }

    public CasResult<List<CasRoleUser>> userListByRole(String roleCode) {
        return this.getUserListByRole(roleCode, HttpGlobalConfig.getTimeout());
    }

    public CasResult<List<CasRoleUser>> userListByRole(String roleCode, int timeout) {
        return this.getUserListByRole(roleCode, timeout);
    }

    /**
     * 新增CAS项目入口和CAS项目角色权限
     *
     * @param userName cas账号
     * @param roleName 角色中文名称
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    private String addUserProject(String userName, String roleName, String token, int timeout) {
        String url = this.host + CasAuthConst.ADD_USER_PROJECT_URL;
        HashMap<String, Object> params = new HashMap<>();
        params.put("projectCode", this.projectCode);
        params.put("token", token);
        params.put("userName", userName);
        params.put("roleName", roleName);
        return HttpUtil.get(url, params, timeout);
    }

    /**
     * 新增CAS项目入口和CAS项目角色权限
     *
     * @param userName cas账号
     * @param roleName 角色中文名称
     * @param token    cas配置的外部接口token
     * @return
     */
    public String addUserProjectAndRole(String userName, String roleName, String token) {
        return this.addUserProject(userName, roleName, token, HttpGlobalConfig.getTimeout());
    }

    /**
     * 新增CAS项目入口和CAS项目角色权限
     *
     * @param userName cas账号
     * @param roleName 角色中文名称
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    public String addUserProjectAndRole(String userName, String roleName, String token, int timeout) {
        return this.addUserProject(userName, roleName, token, timeout);
    }

    /**
     * 获取角色的数据权限和菜单权限列表
     *
     * @param roleCode code
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    private CasResult<RoleModuleAndDataPermissionVo> roleModuleAndDataPermission(String roleCode, String token, int timeout) {
        String url = this.host + CasAuthConst.ROLE_MODULE_AND_DATA_PERMISSION;
        HashMap<String, Object> params = new HashMap<>();
        params.put("projectCode", this.projectCode);
        params.put("token", token);
        params.put("roleCode", roleCode);
        String r = HttpUtil.get(url, params, timeout);
        return JSONObject.parseObject(r, new TypeReference<CasResult<RoleModuleAndDataPermissionVo>>() {
        });
    }

    /**
     * 获取角色的数据权限和菜单权限列表
     *
     * @param roleCode 角色code
     * @param token    cas配置的外部接口token
     * @return
     */
    public CasResult<RoleModuleAndDataPermissionVo> getRoleModuleAndDataPermission(String roleCode, String token) {
        return this.roleModuleAndDataPermission(roleCode, token, HttpGlobalConfig.getTimeout());
    }

    /**
     * 获取角色的数据权限和菜单权限列表
     *
     * @param roleCode 角色code
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    public CasResult<RoleModuleAndDataPermissionVo> getRoleModuleAndDataPermission(String roleCode, String token, int timeout) {
        return this.roleModuleAndDataPermission(roleCode, token, timeout);
    }


    /**
     * 获取用户角色列表
     *
     * @param userName cas账号
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    private CasResult<List<RoleVo>> userRoleList(String userName, String token, int timeout) {
        String url = this.host + CasAuthConst.USER_ROLE_LIST;
        HashMap<String, Object> params = new HashMap<>();
        params.put("projectCode", this.projectCode);
        params.put("token", token);
        params.put("userName", userName);
        String r = HttpUtil.get(url, params, timeout);
        return JSONObject.parseObject(r, new TypeReference<CasResult<List<RoleVo>>>(RoleVo.class) {
        });


    }

    /**
     * 获取用户角色列表
     *
     * @param userName cas账号
     * @param token    cas配置的外部接口token
     * @return
     */
    public CasResult<List<RoleVo>> getUserRoleList(String userName, String token) {
        return this.userRoleList(userName, token, HttpGlobalConfig.getTimeout());
    }

    /**
     * 获取用户角色列表
     *
     * @param userName cas账号
     * @param token    cas配置的外部接口token
     * @param timeout
     * @return
     */
    public CasResult<List<RoleVo>> getUserRoleList(String userName, String token, int timeout) {
        return this.userRoleList(userName, token, timeout);
    }

    /**
     * 校验用户名和密码是否正确
     *
     * @param username 用户名
     * @param password 密码
     * @return
     */
    public CasResult<String> validateUser(String username, String password) {
        String url = this.host + CasAuthConst.VALIDATE_USER;
        HashMap<String, Object> params = new HashMap<>();
        params.put("username", username);
        params.put("password", password);

        String r = HttpUtil.post(url, params, HttpGlobalConfig.getTimeout());
        return JSONObject.parseObject(r, new TypeReference<CasResult<String>>(RoleVo.class) {
        });
    }

}
