package com.br.cas.bean.result;

import com.alibaba.fastjson.annotation.JSONField;
import lombok.Data;

import java.util.Objects;

/**
 * @author yu.zhang
 * created on 2022-07-29
 */
@Data
public class CasAuthResult {
    /**
     * 返回状态
     */
    private String status;

    /**
     * 返回信息描述
     */
    private String msg;

    /**
     * 用户邮箱
     */
    private String email;

    /**
     * 用户姓名
     */
    private String name;

    /**
     * CAS auth_user表ID
     */
    @JSONField(name = "user_id")
    private Integer userId;

    /**
     * 用户登录名
     */
    private String username;

    /**
     * CAS cas_pro表ID
     */
    @JSONField(name = "pro_id")
    private Integer proId;

    /**
     * 用户所属区域
     */
    private String zone;

    /**
     * 用户所属区域ID
     */
    @JSONField(name = "zone_id")
    private Integer zoneId;

    /**
     * 用户项目角色
     */
    private String role;

    /**
     * 用户项目角色ID
     */
    @JSONField(name = "role_id")
    private Integer roleId;

    /**
     * 用户项目角色code
     */
    @JSONField(name = "role_code")
    private String roleCode;

    /**
     * 用户所属部门ID
     */
    private Integer deptId;

    /**
     * 用户所属部门名称
     */
    private String deptName;

    /**
     * 用户申请项目VPN IP
     */
    @JSONField(name = "vpn_ip")
    private String vpnIp;

    /**
     * 项目code
     */
    private String projectCode;


    public boolean ok() {
        return Objects.equals(this.status, "success");
    }
    
    public boolean fail() {
    	return !ok();
    }
}
