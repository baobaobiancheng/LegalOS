package com.br.cas.bean.auth;


import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @Description: 角色菜单权限和数据权限返回数据
 * @Author: guangxu.guo
 * @Date 2024/5/9 17:44
 */
@Data
public class RoleModuleAndDataPermissionVo implements Serializable {
    private static final long serialVersionUID = 1L;
    /**
     * 项目code
     */
    private String projectCode;
    /**
     * 角色ID
     */
    private Integer roleId;
    /**
     * 角色code
     */
    private String roleCode;
    /**
     * 角色名称
     */
    private String roleName;
    /**
     * 菜单权限列表
     */
    private List<ModuleCache> menuList;
    /**
     * 数据权限列表
     */
    private List<DataCategoryVo> dataPermissionList;
}
