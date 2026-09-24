package middleware

import (
	"net/http"
	"strings"

	"aicanvas/handler"
	"aicanvas/model"
	"aicanvas/service"
	"github.com/gin-gonic/gin"
)

func AdminAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok {
		handler.FailAuth(c.Writer)
		c.Abort()
		return
	}
	if user.Role != model.UserRoleAdmin {
		handler.Fail(c.Writer, "未登录或权限不足")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

// AnyAdminAuth 放行超管与二级管理员（admin / admin_l2），其余（guest/user/未登录）拒绝。
func AnyAdminAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok {
		handler.FailAuth(c.Writer)
		c.Abort()
		return
	}
	if user.Role != model.UserRoleAdmin && user.Role != model.UserRoleAdminL2 {
		handler.Fail(c.Writer, "未登录或权限不足")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func UserAuth(c *gin.Context) {
	user, ok := authUser(c)
	if !ok || user.Role == model.UserRoleGuest {
		handler.FailAuth(c.Writer)
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	c.Next()
}

func OptionalAuth(c *gin.Context) {
	if user, ok := authUser(c); ok {
		c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	}
	c.Next()
}

func NotFoundJSON(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"code": 1, "data": nil, "msg": "接口不存在"})
}

func authUser(c *gin.Context) (model.AuthUser, bool) {
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if strings.TrimSpace(token) == "" {
		return model.AuthUser{}, false
	}
	return service.CurrentAuthUser(token)
}
