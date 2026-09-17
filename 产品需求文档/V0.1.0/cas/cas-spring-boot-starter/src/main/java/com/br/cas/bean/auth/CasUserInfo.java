package com.br.cas.bean.auth;

import lombok.Data;

import java.util.List;
import java.util.Set;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasUserInfo {
    /**
     * 用户id
     */
    private Integer userId;

    /**
     * 账号
     */
    private String username;

    /**
     * 姓名
     */
    private String realName;

    /**
     * 状态
     */
    private Integer state;

    /**
     * 角色列表
     */
    private List<Integer> roles;

    /**
     * 模块/权限列表
     */
    private Set<String> modules;

    /**
     * 模块code列表
     */
    private Set<String> moduleCodeList;

    /**
     * 角色详情列表
     */
    private List<CasRole> roleInfoList;
}
