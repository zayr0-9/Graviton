interface ProjectRepoDeps {
  db: any
}

export class ProjectRepo {
  private readonly db: any

  constructor(deps: ProjectRepoDeps) {
    this.db = deps.db
  }

  getById(projectId: string): any | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
    return row ?? null
  }

  touch(projectId: string, at: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, projectId)
  }
}
