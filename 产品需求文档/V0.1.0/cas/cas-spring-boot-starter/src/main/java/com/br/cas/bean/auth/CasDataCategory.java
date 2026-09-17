package com.br.cas.bean.auth;

import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasDataCategory implements Serializable {

    private static final long serialVersionUID = 1L;

    public static CasDataCategory one() {
        return new CasDataCategory();
    }

    private Integer id;
    private String projectCode;
    private String code;
    private String name;
    private String remark;
    private List<CasDataValue> dataValueList;
    private Integer isShow;
}
