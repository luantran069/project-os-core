# Symphony trong lõi

Symphony là bộ điều phối của Project OS. Nó đọc Jira, giao từng ticket đã duyệt
cho một agent Codex chạy trong bản sao repo riêng, và lưu lại workspace khi ticket
xong. Mã điều khiển Symphony nằm ở [`symphony/`](../symphony/) của lõi; dự án không
tự viết phần này.

## Lõi cung cấp gì

| File           | Lệnh trong dự án           | Việc làm                                                                                                          |
| -------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `runtime.json` | —                          | Ghim bản Symphony v0.0.3 và mã SHA-256 cho từng nền tảng.                                                         |
| `setup.mjs`    | `npm run symphony:setup`   | Tải bản Symphony đã ghim về `.symphony/bin` và kiểm tra checksum.                                                 |
| `check.mjs`    | `npm run symphony:check`   | Đối chiếu `WORKFLOW.md` với hợp đồng của lõi và `project.yaml`. Thêm `-- --live` để kiểm tra Jira thật (chỉ đọc). |
| `probe.mjs`    | `npm run symphony:probe`   | Thử khởi tạo `codex app-server` trên máy worker, không chạy lượt nào.                                             |
| `codex.mjs`    | (Symphony gọi)             | Cầu nối tới Codex; chỉ mở quyền ghi cho `.git` của chính ticket.                                                  |
| `archive.mjs`  | (hook `before_remove`)     | Giữ lại repo và worktree của ticket trong `.symphony/archives`.                                                   |
| `start.mjs`    | `npm run symphony:start`   | Kiểm tra trực tiếp rồi chạy Symphony với `WORKFLOW.md`.                                                           |
| `service.mjs`  | `npm run symphony:service` | Cài và điều khiển dịch vụ systemd của người dùng cho worker.                                                      |
| `project.mjs`  | —                          | Đọc `project.yaml` và `WORKFLOW.md`, dùng chung cho các file trên.                                                |

Mọi lệnh chạy từ thư mục gốc của dự án. Tên dịch vụ và thư mục chứa thông tin
đăng nhập Jira lấy từ `project.name`, ví dụ "Investment Storylines" thành
`investment-storylines-symphony.service` và `~/.config/investment-storylines/`.

## Cách dự án nhận các file này

`scripts/sync-project.mjs <dự án>` chép `symphony/` vào `.project-os/symphony/`
của dự án, ghi mã băm vào `.project-os/core.json` và ghim `core.version` trong
`project.yaml`. Dự án commit các file này, nên worker, Docker và các bản sao của
ticket không cần quyền truy cập repo lõi.

Không sửa file trong `.project-os/` ở dự án. `check-project` báo lỗi khi một file
khác với mã băm đã ghi. Muốn đổi thì sửa trong lõi, tăng phiên bản, rồi sync lại.

## Những gì dự án tự khai báo

Trong `project.yaml`:

- `tracker.project_key`, `runtime.max_concurrent_agents`, `runtime.max_turns`:
  phải khớp với `WORKFLOW.md`.
- `runtime.setup_command` (ví dụ `npm ci`): phải có trong hook `after_create`.
- `runtime.verify_command` (ví dụ `npm run verify`): phải có trong prompt của agent.
- `labels.*`: nhãn `ready` phải nằm trong `required_labels`; nhãn `blocked` và
  `pilot_review` phải được nhắc trong prompt.

Phần lõi cố định: tên trạng thái Jira (`Ready for delivery`, `Delivery`, `Impact`,
`Done`), lệnh `node .project-os/symphony/codex.mjs`, hook lưu trữ, và cổng giám
sát chỉ nghe trên `127.0.0.1`.
