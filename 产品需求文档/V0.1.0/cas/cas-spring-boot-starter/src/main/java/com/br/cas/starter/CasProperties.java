package com.br.cas.starter;

import lombok.Data;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
@ConfigurationProperties(prefix = CasProperties.PREFIX)
@ConditionalOnProperty(prefix = CasProperties.PREFIX, name = {"host", "projectCode"})
public class CasProperties {

    public static final String PREFIX = "br-cas";

    /**
     * 请求地址
     */
    private String host;

    /**
     * 项目code
     */
    private String projectCode;
}
