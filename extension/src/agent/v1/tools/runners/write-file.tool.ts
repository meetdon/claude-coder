import * as path from "path"
import { ClaudeSayTool } from "../../../../shared/ExtensionMessage"
import { ToolResponse } from "../../types"
import { formatToolResponse, getCwd, getReadablePath } from "../../utils"
import { AgentToolOptions, AgentToolParams } from "../types"
import { BaseAgentTool } from "../base-agent.tool"
import { DiffViewProvider } from "../../../../integrations/editor/diff-view-provider"
import { fileExistsAtPath } from "../../../../utils/path-helpers"
import pWaitFor from "p-wait-for"

export class WriteFileTool extends BaseAgentTool {
	protected params: AgentToolParams
	public diffViewProvider: DiffViewProvider
	private isProcessingFinalContent: boolean = false
	private lastUpdateTime: number = 0
	private readonly UPDATE_INTERVAL = 8
	private skipWriteAnimation: boolean = false

	constructor(params: AgentToolParams, options: AgentToolOptions) {
		super(options)
		this.params = params
		this.diffViewProvider = new DiffViewProvider(getCwd(), this.koduDev, this.UPDATE_INTERVAL)
		if (!!this.koduDev.getStateManager().skipWriteAnimation) {
			this.skipWriteAnimation = true
		}
	}

	override async execute(): Promise<ToolResponse> {
		const result = await this.processFileWrite()
		return result
	}

	public async handlePartialUpdate(relPath: string, content: string): Promise<void> {
		// this might happen because the diff view are not instant.
		if (this.isProcessingFinalContent) {
			this.logger("Skipping partial update because the tool is processing the final content.", "warn")
			return
		}
		// if the user has skipped the write animation, we don't need to show the diff view until we reach the final state
		if (this.skipWriteAnimation) {
			this.params.updateAsk(
				"tool",
				{ tool: { tool: "write_to_file", content, path: relPath, ts: this.ts, approvalState: "loading" } },
				this.ts
			)
			return
		}

		const currentTime = Date.now()
		// don't push too many updates to the diff view provider to avoid performance issues
		if (currentTime - this.lastUpdateTime < this.UPDATE_INTERVAL) {
			return
		}

		if (!this.diffViewProvider.isDiffViewOpen()) {
			try {
				// this actually opens the diff view but might take an extra few ms to be considered open requires interval check
				// it can take up to 300ms to open the diff view
				await this.diffViewProvider.open(relPath)
			} catch (e) {
				this.logger("Error opening diff view: " + e, "error")
				return
			}
		}
		await this.diffViewProvider.update(content, false)
		this.lastUpdateTime = currentTime
	}

	private async processFileWrite(): Promise<ToolResponse> {
		try {
			const { path: relPath, content } = this.params.input

			if (!relPath || !content) {
				throw new Error("Missing required parameters 'path' or 'content'")
			}
			// switch to final state asap
			this.isProcessingFinalContent = true

			// Show changes in diff view
			await this.showChangesInDiffView(relPath, content)

			// Ask for user approval
			console.log("Asking for user approval")
			const { response, text, images } = await this.params.ask(
				"tool",
				{
					tool: {
						tool: "write_to_file",
						content: content,
						approvalState: "pending",
						path: relPath,
						ts: this.ts,
					},
				},
				this.ts
			)

			if (response !== "yesButtonTapped") {
				await this.diffViewProvider.revertChanges()
				await this.params.updateAsk(
					"tool",
					{
						tool: {
							tool: "write_to_file",
							content: content,
							approvalState: "rejected",
							path: relPath,
							ts: this.ts,
							userFeedback: text,
						},
					},
					this.ts
				)
				if (response === "noButtonTapped") {
					return formatToolResponse("Write operation cancelled by user.")
				}
				await this.params.say("user_feedback", text ?? "The user denied this operation.", images)
				return formatToolResponse(text ?? "Write operation cancelled by user.", images)
			}

			// Save changes and handle user edits
			const fileExists = await this.checkFileExists(relPath)
			const { userEdits } = await this.diffViewProvider.saveChanges()

			// Final approval state
			await this.params.updateAsk(
				"tool",
				{
					tool: {
						tool: "write_to_file",
						content: content,
						approvalState: "approved",
						path: relPath,
						ts: this.ts,
					},
				},
				this.ts
			)

			if (userEdits) {
				await this.params.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: fileExists ? "editedExistingFile" : "newFileCreated",
						path: getReadablePath(getCwd(), relPath),
						diff: userEdits,
					} as ClaudeSayTool)
				)
				return formatToolResponse(
					`The user made the following updates to your content:\n\n${userEdits}\n\nThe updated content has been successfully saved to ${relPath.toPosix()}. (Note: you don't need to re-write the file with these changes.)`
				)
			}

			return formatToolResponse(
				`The content was successfully saved to ${relPath.toPosix()}. Do not read the file again unless you forgot the content.`
			)
		} catch (error) {
			console.error("Error in processFileWrite:", error)
			return formatToolResponse(
				`Write to File Error With:${error instanceof Error ? error.message : String(error)}`
			)
		} finally {
			this.isProcessingFinalContent = false
			this.diffViewProvider.isEditing = false
		}
	}

	private async showChangesInDiffView(relPath: string, content: string): Promise<void> {
		content = this.preprocessContent(content)

		if (!this.diffViewProvider.isDiffViewOpen()) {
			await this.diffViewProvider.open(relPath)
		}

		await this.diffViewProvider.update(content, true)
	}

	private async checkFileExists(relPath: string): Promise<boolean> {
		const absolutePath = path.resolve(getCwd(), relPath)
		return await fileExistsAtPath(absolutePath)
	}

	override async abortToolExecution(): Promise<void> {
		console.log("Aborting WriteFileTool execution")
		await this.diffViewProvider.revertChanges()
	}

	private preprocessContent(content: string): string {
		content = content.trim()
		if (content.startsWith("```")) {
			content = content.split("\n").slice(1).join("\n").trim()
		}
		if (content.endsWith("```")) {
			content = content.split("\n").slice(0, -1).join("\n").trim()
		}
		return content.replace(/>/g, ">").replace(/</g, "<").replace(/"/g, '"')
	}
}
