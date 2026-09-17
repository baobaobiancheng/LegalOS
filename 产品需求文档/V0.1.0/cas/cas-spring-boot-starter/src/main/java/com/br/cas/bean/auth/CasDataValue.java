package com.br.cas.bean.auth;

import com.br.cas.common.JtnNode;
import lombok.Data;

import java.io.Serializable;
import java.util.List;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasDataValue implements Serializable, JtnNode<Integer, CasDataValue> {
    private static final long serialVersionUID = 1L;

    public static CasDataValue one() {
        return new CasDataValue();
    }

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

    private Boolean checked = false;

    private List<CasDataValue> childList;

    public static CasDataValue cloneSelf(CasDataValue orgTreeNode) {
        CasDataValue newNode = new CasDataValue();
        newNode.setId(orgTreeNode.getId());
        newNode.setProjectCode(orgTreeNode.getProjectCode());
        newNode.setCategoryId(orgTreeNode.getCategoryId());
        newNode.setParentId(orgTreeNode.getParentId());
        newNode.setCode(orgTreeNode.getCode());
        newNode.setName(orgTreeNode.getName());
        newNode.setValue(orgTreeNode.getValue());
        newNode.setExtra(orgTreeNode.getExtra());
        newNode.setRemark(orgTreeNode.getRemark());
        newNode.setSort(orgTreeNode.getSort());
        newNode.setChecked(orgTreeNode.checked);
        return newNode;
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj)
            return true;
        if (obj == null)
            return false;
        if (getClass() != obj.getClass())
            return false;
        CasDataValue other = (CasDataValue) obj;
        if (id == null) {
            if (other.id != null)
                return false;
        } else if (!id.equals(other.id))
            return false;
        return true;
    }

    @Override
    public int hashCode() {
        final int prime = 31;
        int result = 1;
        result = prime * result + ((id == null) ? 0 : id.hashCode());
        return result;
    }
}
