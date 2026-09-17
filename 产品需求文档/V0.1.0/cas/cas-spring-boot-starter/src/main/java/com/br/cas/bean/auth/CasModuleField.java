package com.br.cas.bean.auth;

import lombok.Data;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasModuleField {

    private Integer id;

    private Integer moduleId;
    private String name;
    private String enname;
    private String code;

    private Integer sort;
    private String remark;
    private Boolean checked;

    public static CasModuleField cloneSelf(CasModuleField node) {
        CasModuleField newNode = new CasModuleField();
        newNode.setId(node.getId());
        newNode.setModuleId(node.getModuleId());
        newNode.setName(node.getName());
        newNode.setEnname(node.getEnname());
        newNode.setCode(node.getCode());
        newNode.setSort(node.getSort());
        newNode.setRemark(node.getRemark());
        newNode.setChecked(node.checked);
        return newNode;
    }
}
