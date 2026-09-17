package com.br.cas.bean.auth;

import lombok.Data;

import java.io.Serializable;

/**
 * 角色信息dto
 *
 * @author zequn.yang
 * created on 2018/07/24
 */
@Data
public class RoleVo implements Serializable {
    private static final long serialVersionUID = 1L;

    /**
     * 角色id
     */
    private Integer roleId;

    /**
     * 角色名称
     */
    private String roleName;

    /**
     * 角色code
     */
    private String code;

    /**
     * 是否启用状态 1启用 0停用
     */
    private Integer state;


    /**
     * 备注
     */
    private String remarks;

    /**
     * 是否特批
     */
    private Integer important;

    /**
     * 是否支持申请
     */
    private Integer applyFor;
}
