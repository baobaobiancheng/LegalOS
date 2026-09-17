package com.br.cas.bean.auth;

import lombok.Data;

/**
 * @author yu.zhang
 * created on 2022-08-05
 */
@Data
public class CasRoleUser {
    /**
     * 登录名
     */
    private String username;

    /**
     * 姓名
     */
    private String realName;

    /**
     * 邮箱
     */
    private String email;

    /**
     * 账号状态
     */
    private Integer state;
}
