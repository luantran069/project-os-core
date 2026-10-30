# Chuyển dự án từ Jira sang GitHub Issues

Làm một lần cho mỗi dự án đang dùng Jira (ví dụ good-ideas với dự án IS). Chạy
trên máy worker, nơi đã có thông tin đăng nhập Jira.

1. Sync dự án lên core 0.3.0 và thêm `labels.in_progress: symphony-in-progress`
   vào `project.yaml`. Giữ `tracker.kind: jira` cho tới bước 4.
2. Chạy thử, không ghi gì:

   ```bash
   JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... GITHUB_TOKEN=... \
     npm run symphony:migrate-jira -- --jira-project IS
   ```

   Lệnh in ra từng ticket sẽ thành issue nào, với nhãn nào và phụ thuộc gì.
   Ticket đã Done chỉ được ghi vào `docs/jira-archive.md`, không thành issue.

3. Đọc danh sách. Nếu đúng, chạy lại với `--apply`. Lệnh tạo các nhãn còn thiếu,
   tạo issue (kèm bình luận Jira, ưu tiên Roadmap thành `priority-now/next/later`,
   phụ thuộc "Blocks" thành dòng **Phụ thuộc** trong mô tả) và ghi file lưu trữ.
   Chạy lại lần nữa không tạo trùng: issue đã có dấu `<!-- jira:IS-12 -->` được bỏ qua.
4. Dừng service Symphony. Đổi `project.yaml` sang `tracker: { kind: github, repo: ... }`
   và `WORKFLOW.md` theo `template/WORKFLOW.md`. Cài lại service với file nguồn chỉ
   chứa `GITHUB_TOKEN` (xem [Symphony trong lõi](symphony.md#github-issues)), chạy
   `npm run symphony:check -- --live`, rồi bật service.
5. Triển khai board theo [Board dự án](board.md) và chạy thử một feature nhỏ từ
   đầu đến cuối. Đạt rồi mới đóng dự án Jira.

Token GitHub cho bước 2–3 cần quyền Issues đọc/ghi trên repo dự án.
