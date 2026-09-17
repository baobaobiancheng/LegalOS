package com.br.cas.bean.result;

import lombok.Data;

import java.util.Objects;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasResult<T> {
    private Integer code;
    private String message;
    private T result;

    public boolean ok() {
        return Objects.equals(this.code, 0);
    }
    
    public boolean fail() {
    	return !ok();
    }
}
