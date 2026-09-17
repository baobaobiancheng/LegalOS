package com.br.cas.bean.auth;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @Description: 数据权限明细返回数据
 * @Author: guangxu.guo
 * @Date 2024/5/9 19:36
 */
@Data
public class DataValueVo implements Serializable {
    private static final long serialVersionUID = 1L;
    private Integer id;
    private String projectCode;
    private Integer categoryId;
    private Integer parentId;
    private String code;
    private String name;
    private String value;
    private String extra;
    private String remark;
    private Integer sort;
    private Boolean checked;
    private List<DataValueVo> childList;
}
