package com.br.cas.common;

import java.io.Serializable;
import java.util.List;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
public interface JtnNode<K, T extends JtnNode<K, T>> extends Serializable {
    void setId(K var1);

    K getId();

    void setParentId(K var1);

    K getParentId();

    void setChildList(List<T> var1);

    List<T> getChildList();
}
