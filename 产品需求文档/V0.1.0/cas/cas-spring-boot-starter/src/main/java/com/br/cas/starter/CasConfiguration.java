package com.br.cas.starter;

import com.br.cas.service.CasAuthService;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Configuration
@EnableConfigurationProperties(CasProperties.class)
@ConditionalOnProperty(prefix = CasProperties.PREFIX, name = {"host", "projectCode"})
public class CasConfiguration {

    private CasProperties casProperties;


    public CasConfiguration(CasProperties casProperties) {
        this.casProperties = casProperties;
    }

    @Bean
    @ConditionalOnMissingBean
    public CasAuthService casAuthService() {
        String host = casProperties.getHost();
        if (host.endsWith("/")) {
            host = host.substring(0, host.length() - 1);
        }
        return new CasAuthService(host, casProperties.getProjectCode());
    }
}
