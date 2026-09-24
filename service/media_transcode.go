package service

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"aicanvas/model"
	"aicanvas/repository"
)

const (
	// mediaTranscodeMaxWait 单个任务的挂钟上限。实测（8 核机器）1440x2560 的 HEVC 转 720p 约为实时的 0.3 倍
	// （20 秒素材 5.7 秒转完），一小时足够覆盖十几分钟的长片。超时即判失败，不留半死不活的任务。
	mediaTranscodeMaxWait = 60 * time.Minute
	// mediaTranscodePreviewEdge 预览版长边。节点在画布上的显示区不过两三百像素，
	// 720p 已经远超所需；再高只是白烧 CPU 和带宽。
	mediaTranscodePreviewEdge = 1280
)

// mediaTranscodeSlots 并发闸门。转码是本服务里最吃 CPU 的活，把 CPU 跑满会把生图等其它活一起拖慢。
// 默认 2；用 MEDIA_TRANSCODE_CONCURRENCY 覆盖（改 .env 重启即生效），夹到 [1,8]。
var mediaTranscodeSlots = make(chan struct{}, mediaTranscodeConcurrency())

func mediaTranscodeConcurrency() int {
	raw := strings.TrimSpace(os.Getenv("MEDIA_TRANSCODE_CONCURRENCY"))
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		value = 2
	}
	if value > 8 {
		value = 8
	}
	return value
}

// StartMediaTranscodeJob 给一个源片排一份预览版。
//
// 不扣点数：这不是一项 AI 能力，只是「让你上传的视频在画布里能看」，属于基础可用性。
// 花的是本机自己的 CPU，成本由 mediaTranscodeSlots 这道闸门兜着。
func StartMediaTranscodeJob(userID, sourceKey string) (model.MediaTranscodeJob, error) {
	key := strings.TrimSpace(sourceKey)
	if key == "" {
		return model.MediaTranscodeJob{}, safeMessageError{message: "缺少视频的存储标识"}
	}
	// 同一个源片只转一次：已成功的直接还地址，还在跑的让调用方接着轮询。
	if existing, found := repository.FindMediaTranscodeJobBySource(userID, key); found {
		return existing, nil
	}
	sourceURL, err := ResolveMediaSourceURL(userID, key)
	if err != nil {
		return model.MediaTranscodeJob{}, err
	}
	job := model.MediaTranscodeJob{
		ID:        newID("mtc"),
		UserID:    userID,
		SourceKey: key,
		SourceURL: sourceURL,
		Status:    "pending",
		CreatedAt: now(),
		UpdatedAt: now(),
	}
	if job, err = repository.SaveMediaTranscodeJob(job); err != nil {
		return model.MediaTranscodeJob{}, err
	}
	go runMediaTranscodeJob(job.ID)
	return job, nil
}

// ResumeMediaTranscodeJobs 服务启动时把没跑完的任务捡回来。
// ⚠️ 必须在 main.go 里真的调用它——历史上另一处同类的恢复函数就写了却始终没接上，
// 结果每次部署重启都会留下一批永远卡在 running 的任务。
func ResumeMediaTranscodeJobs() {
	jobs, err := repository.ListUnfinishedMediaTranscodeJobs()
	if err != nil {
		log.Printf("转码任务恢复失败: %v", err)
		return
	}
	if len(jobs) == 0 {
		return
	}
	log.Printf("转码任务恢复: 捡回 %d 个未完成任务", len(jobs))
	for _, job := range jobs {
		go runMediaTranscodeJob(job.ID)
	}
}

func failMediaTranscodeJob(job model.MediaTranscodeJob, reason string) {
	job.Status = "failed"
	job.Error = reason
	job.UpdatedAt = now()
	if _, err := repository.SaveMediaTranscodeJob(job); err != nil {
		log.Printf("转码任务 %s 置失败时落库出错: %v", job.ID, err)
	}
}

func runMediaTranscodeJob(jobID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("转码任务 %s 协程 panic: %v", jobID, r)
		}
	}()
	job, ok, err := repository.GetMediaTranscodeJob(jobID)
	if err != nil || !ok || job.Status == "succeeded" || job.Status == "failed" {
		return
	}
	// 排队等一个槽位。这里不设上限：宁可让用户多等，也不能因为一时拥挤就把任务丢掉。
	mediaTranscodeSlots <- struct{}{}
	defer func() { <-mediaTranscodeSlots }()

	// 抢到槽位后重新读一遍：排队期间可能已经被别的协程（比如重启恢复）跑完了。
	job, ok, err = repository.GetMediaTranscodeJob(jobID)
	if err != nil || !ok || job.Status == "succeeded" || job.Status == "failed" {
		return
	}
	startedAt := time.Now()
	job.Status = "running"
	job.UpdatedAt = now()
	if job, err = repository.SaveMediaTranscodeJob(job); err != nil {
		log.Printf("转码任务 %s 置 running 失败: %v", job.ID, err)
		return
	}

	out := fmt.Sprintf("/tmp/mtc-%s.mp4", job.ID)
	defer os.Remove(out)

	// 先探一次源片时长，作为进度的分母。探不到不影响转码，只是前端没有百分比可显示。
	if probe, perr := ProbeVideo(job.SourceURL); perr == nil && probe.DurationMs > 0 {
		job.SourceDurationMs = probe.DurationMs
		job.UpdatedAt = now()
		if saved, serr := repository.SaveMediaTranscodeJob(job); serr == nil {
			job = saved
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), mediaTranscodeMaxWait)
	defer cancel()
	// ffmpeg 直接读远端 URL：源片可能几百 MB，先整个下到内存里既慢又危险。
	// force_divisible_by=2 是 H.264 的硬要求（奇数边会直接编码失败）；
	// +faststart 把 moov 挪到文件头，浏览器边下边播而不是等整个文件。
	scale := fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		mediaTranscodePreviewEdge, mediaTranscodePreviewEdge)
	args := []string{
		"-v", "error", "-y",
		"-progress", "pipe:1", "-nostats",
		"-i", job.SourceURL,
		"-vf", scale,
		// ⚠️ 必须限制线程数。不限的话 libx264 会把所有 CPU 核心全吃掉，两路并发就是 16 个可运行线程，
		// 把生图 / HTTP 处理一起拖下水。实测（8 核机器）4 路 × 3 线程时 1 分钟负载已经到 10.65，
		// 而 2 路 × 3 线程仍然轻松。
		"-threads", "3",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k",
		"-movflags", "+faststart",
		"-max_muxing_queue_size", "1024",
		out,
	}
	if ferr := runFFmpegWithProgress(ctx, args, &job); ferr != nil {
		log.Printf("转码任务 %s ffmpeg 失败: %v", job.ID, ferr)
		failMediaTranscodeJob(job, "转码失败")
		return
	}
	data, rerr := os.ReadFile(out)
	if rerr != nil || len(data) == 0 {
		failMediaTranscodeJob(job, "转码产物为空")
		return
	}
	publicURL, uerr := UploadToTOSForUser(job.UserID, "media/"+job.UserID+"/preview/"+job.ID+".mp4", data, "video/mp4")
	if uerr != nil {
		log.Printf("转码任务 %s 转存失败: %v", job.ID, uerr)
		failMediaTranscodeJob(job, "预览版上传失败")
		return
	}
	// 产物规格拿来回填节点框——顺带把「浏览器读不到宽高」那条路也补上了。
	if probe, perr := ProbeVideo(publicURL); perr == nil {
		job.Width = probe.Width
		job.Height = probe.Height
	}
	job.Status = "succeeded"
	job.PreviewURL = publicURL
	job.Bytes = int64(len(data))
	job.DurationMs = int(time.Since(startedAt).Milliseconds())
	job.Error = ""
	job.UpdatedAt = now()
	if _, serr := repository.SaveMediaTranscodeJob(job); serr != nil {
		log.Printf("转码任务 %s 置成功时落库出错: %v", job.ID, serr)
		return
	}
	log.Printf("转码任务 %s 完成: %d 字节, 耗时 %dms", job.ID, job.Bytes, job.DurationMs)
}

// runFFmpegWithProgress 跑 ffmpeg 并把进度写回任务行。
//
// ffmpeg 的 -progress pipe:1 会周期性吐出 key=value，其中 out_time_us 是已经处理到的时间点。
// 拿它除以源片总时长就是百分比。落库有节流：转一个 5 分钟的片子会吐几百次，
// 每次都写库既没必要、也会把 sync_data 那条连接占着。
func runFFmpegWithProgress(ctx context.Context, args []string, job *model.MediaTranscodeJob) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	total := job.SourceDurationMs
	lastWrite := time.Now()
	lastPct := -1
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "out_time_us=") || total <= 0 {
			continue
		}
		micro, perr := strconv.ParseInt(strings.TrimPrefix(line, "out_time_us="), 10, 64)
		if perr != nil || micro < 0 {
			continue
		}
		pct := int(micro / 1000 * 100 / int64(total))
		if pct < 0 {
			pct = 0
		}
		// 99 封顶：100 只在真正落库成功之后才出现，避免「显示 100% 却还没好」。
		if pct > 99 {
			pct = 99
		}
		// 节流：至少隔 1.5 秒、且百分比确实变了才写库。
		if pct == lastPct || time.Since(lastWrite) < 1500*time.Millisecond {
			continue
		}
		lastPct = pct
		lastWrite = time.Now()
		job.Progress = pct
		job.UpdatedAt = now()
		if saved, serr := repository.SaveMediaTranscodeJob(*job); serr == nil {
			*job = saved
		}
	}
	if werr := cmd.Wait(); werr != nil {
		snippet := strings.TrimSpace(stderr.String())
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		return fmt.Errorf("%v | %s", werr, snippet)
	}
	return nil
}

// resolveMediaSourceURL 把存储标识解析成上游够得着的公网地址。
// 本地盘上的历史文件会被转存进本组的桶，再返回新地址。
func ResolveMediaSourceURL(userID, storageKey string) (string, error) {
	key := strings.TrimSpace(storageKey)
	if key == "" {
		return "", safeMessageError{message: "该视频缺少存储标识，请重新上传后再试"}
	}
	item, err := repository.GetSyncFile(userID, key)
	if err != nil || item.ID == "" {
		// 跨账号回退：仅认公网地址，本地磁盘文件继续按账号隔离。
		fallback, ferr := repository.GetPublicSyncFileByKey(key)
		if ferr == nil && fallback.ID != "" && isPublicHTTPURL(fallback.Path) {
			return fallback.Path, nil
		}
		return "", safeMessageError{message: "这个视频还没有同步到云端，请稍等片刻再试"}
	}
	if isPublicHTTPURL(item.Path) {
		return item.Path, nil
	}
	data, rerr := os.ReadFile(item.Path)
	if rerr != nil {
		return "", safeMessageError{message: "读取视频文件失败，请重新上传后再试"}
	}
	mime := item.MimeType
	if strings.TrimSpace(mime) == "" {
		mime = "video/mp4"
	}
	publicURL, uerr := UploadToTOSForUser(userID, "media/"+userID+"/transcode-src/"+newID("src")+".mp4", data, mime)
	if uerr != nil {
		return "", uerr
	}
	return publicURL, nil
}

// isPublicHTTPURL 判断是不是一个上游够得着的公网地址。
func isPublicHTTPURL(value string) bool {
	v := strings.TrimSpace(value)
	return strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://")
}
