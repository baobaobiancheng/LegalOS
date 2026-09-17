package com.br.cas.bean.auth;

import lombok.Data;

import java.util.Date;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasRole {
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
     * 角色状态
     */
    private Integer state;

    /**
     * 创建人
     */
    private String createUser;

    /**
     * 创建时间
     */
    private Date createTime;

    /**
     * 更新人
     */
    private String updateUser;

    /**
     * 更新时间
     */
    private Date updateTime;

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
