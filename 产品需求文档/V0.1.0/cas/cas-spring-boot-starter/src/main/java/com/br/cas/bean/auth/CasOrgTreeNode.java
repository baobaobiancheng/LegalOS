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
public class CasOrgTreeNode implements Serializable, JtnNode<String, CasOrgTreeNode> {

    private static final long serialVersionUID = 1L;

    private String id;
    private String pid;
    private String name;

    private List<CasOrgTreeNode> children;
    private Boolean checked;

    public static CasOrgTreeNode cloneSelf(CasOrgTreeNode casOrgTreeNode) {
        CasOrgTreeNode newNode = new CasOrgTreeNode();
        newNode.setId(casOrgTreeNode.getId());
        newNode.setPid(casOrgTreeNode.getPid());
        newNode.setName(casOrgTreeNode.getName());
        newNode.setChecked(casOrgTreeNode.checked);
        return newNode;
    }

    @Override
    public void setParentId(String parentId) {
        this.pid = parentId;
    }

    @Override
    public String getParentId() {
        return pid;
    }

    @Override
    public void setChildList(List<CasOrgTreeNode> childList) {
        this.children = childList;
    }

    @Override
    public List<CasOrgTreeNode> getChildList() {
        return children;
    }
}
