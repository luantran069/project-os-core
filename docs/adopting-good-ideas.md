# Đưa good-ideas về dùng lõi

good-ideas là dự án thử đầu tiên. Lõi v0 được rút ra từ commit `8574f71` của nó.

## Đã rút ra

| Trong good-ideas                 | Trong lõi                                        | Thay đổi                                                       |
| -------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `AGENTS.md` (worktree, ticket)   | `template/AGENTS.md`                             | Bỏ phần tài chính và lệnh kiểm tra riêng; để chỗ trống.        |
| `WORKFLOW.md`                    | `template/WORKFLOW.md`                           | Bỏ tên dự án, trạng thái Jira và lệnh npm riêng; để chỗ trống. |
| `docs/idea-planning-template.md` | `template/docs/idea-planning-template.md`        | Bỏ bảng dữ liệu tài chính, giữ hợp đồng ticket.                |
| `docs/symphony-adoption.md`      | `gates/README.md`, `playbooks/agent-delivery.md` | Chỉ giữ phần chung: nhãn, workpad, quy tắc merge.              |
| Nhãn `symphony-*`                | `project.yaml` → `labels`                        | Giữ nguyên tên làm mặc định để good-ideas không phải đổi gì.   |

| `scripts/symphony-*.mjs`, `symphony-runtime.json`, bài test | `symphony/`, `tests/symphony-*.test.ts` (lõi 0.2.0) | Tên dịch vụ, thư mục cấu hình và các giá trị kiểm tra `WORKFLOW.md` lấy từ `project.yaml` thay vì viết cứng. |

## Còn lại trong good-ideas

- Toàn bộ quy tắc dữ liệu tài chính và các dịch vụ của Investment Storylines.
- Runbook vận hành worker trên máy chủ (`docs/symphony-service.md`), vì nó ghi
  đường dẫn và tài khoản cụ thể của máy đó.

## Các bước để good-ideas dùng lõi

Mỗi bước là một pull request nhỏ trong good-ideas, không bước nào đổi hành vi
của agent đang chạy:

1. Thêm `project.yaml` với `core.version: 0.1.0`, nhãn `symphony-*`, tracker `IS`.
2. Thêm `memory/` (vision, state, learnings, decisions) và chuyển các quyết định
   đã có trong `docs/` thành ADR khi cần.
3. Chạy `node <lõi>/scripts/check-project.mjs .` và sửa đến khi qua.
4. Sau đó mới cân nhắc chuyển script Symphony sang lõi.
