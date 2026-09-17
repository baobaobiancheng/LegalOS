package com.br.cas.bean.auth;

import lombok.Data;

import java.util.Date;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasModuleUrl {
    /**
     * 数据ID
     */
    private Integer id;

    /**
     * 项目ID
     */
    private Integer projectId;

    /**
     * 模块ID
     */
    private Integer moduleId;

    /**
     * 接口url
     */
    private String url;

    /**
     * 备注
     */
    private String remark;

    /**
     * 创建时间
     */
    private Date createTime;

    /**
     * 是否删除
     */
    private Integer deleted;
}
