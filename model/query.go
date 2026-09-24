package model

const MaxPageSize = 500

// Query 列表筛选和分页参数。
type Query struct {
	Keyword  string
	Tags     []string
	Category string
	Type     string
	IP       string // 按客户端 IP 精确筛选（短信记录）
	Page     int
	PageSize int
	// CreatorID 非空时按创建者过滤用户列表（二级管理员只看自己创建的子用户）。
	CreatorID string
	// UserIDs 非空时把流水限制在这些 user_id 内（二级管理员只看自己子用户的流水）。
	UserIDs []string
	// 以下为积分流水（credit_logs）专用筛选，其它列表不读：
	Model  string // 按模型名筛选（流水的 extra JSON / remark 里含模型名）
	Member string // 按成员筛选：匹配 user_id 或用户名（子查询解析）
	Start  string // created_at >= Start（RFC3339）
	End    string // created_at <= End（RFC3339）
	// Source 来源筛选（credit_logs 专用）：空=全部；"__personal__"=个人积分（project_id 空）；其它=具体项目 id（该项目积分池）。
	Source string
}

func (q *Query) Normalize() {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 {
		q.PageSize = 20
	}
	if q.PageSize > MaxPageSize {
		q.PageSize = MaxPageSize
	}
}

func (q *Query) Offset() int {
	return (q.Page - 1) * q.PageSize
}
