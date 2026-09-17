package com.br.cas.bean.auth;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @Description: 数据权限项目返回数据
 * @Author: guangxu.guo
 * @Date 2024/5/9 19:35
 */
@Data
public class DataCategoryVo implements Serializable {
    private static final long serialVersionUID = 1L;
    private Integer id;
    private String projectCode;
    private String code;
    private String name;
    private String remark;
    private List<DataValueVo> dataValueList;
    private Integer isShow;
}
