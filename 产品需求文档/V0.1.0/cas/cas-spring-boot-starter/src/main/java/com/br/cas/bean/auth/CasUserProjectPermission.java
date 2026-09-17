package com.br.cas.bean.auth;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasUserProjectPermission {
    /**
     * 用户信息
     */
    private CasUserInfo userInfo;

    /**
     * 菜单列表
     */
    private String menuList;

    /**
     * 测试数据权限标志，1表示有，0和其它表示无
     */
    private Integer testDataPermission;

    /**
     * 数据权限列表
     */
    private List<CasDataCategory> dataPermissionList;

    private Map<String, List<CasOrgTreeNode>> orgPermissionMap;
    private Map<String, CasOrgPersonPermission> personPermissionMap;

    /**
     * 字段权限，用code作为key，而不是moduleId
     */
    private Map<String, List<CasModuleField>> fieldPermissionMap;

    /**
     * 接口权限
     */
    private List<CasModuleUrl> moduleUrlList;
}
