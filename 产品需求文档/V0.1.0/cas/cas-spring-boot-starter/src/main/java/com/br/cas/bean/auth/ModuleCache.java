package com.br.cas.bean.auth;

import lombok.Data;

import java.io.Serializable;
import java.util.Date;

/**
 * @Description: 菜单权限返回数据
 * @Author: guangxu.guo
 * @Date 2024/5/9 19:35
 */
@Data
public class ModuleCache implements Serializable {
    private static final long serialVersionUID = 1L;
    private Integer moduleId;
    private Integer parentId;

    private String name;

    private Integer sort;

    private String curl;

    private Integer ctype;

    private Integer state;

    private String createUser;

    private Date createTime;

    private String updateUser;

    private Date updateTime;

    private String projectCode;

    private String remarks;
    private String code;

    private Integer important;

    /**
     * 是否支持申请
     */
    private Integer applyFor;
}